/**
 * The `deploy` runner for the create flow.
 *
 * It selects the next step whose prerequisites are all verified, executes it,
 * writes the outcome to the journal with a compare-and-swap, and reports it as
 * one schema-valid event. It stops — rather than skipping ahead — the moment a
 * step needs a client action or a human review, and it only runs the create
 * verification profile once every step is verified.
 */

import {
  deriveCreateFlowState,
  deriveInstallationPhase,
  selectNextCreateStep,
  type CreateFlowStepDefinition,
  type CreateFlowState,
  type InstallationPhase,
} from "./create-flow";
import type { CreateVerificationReport } from "./installation-verification";
import type { InstallationIdentity } from "./installation-identity";
import { resumableCommandLine, type ResumableCommand } from "./operator-cli";
import { OperatorError } from "./operator-errors";
import {
  createProvisioningStep,
  type ProvisioningJournal,
  type ProvisioningResource,
  type ProvisioningStep,
} from "./provisioning-journal";
import {
  terminalExitCodeFor,
  type DeploymentScope,
  type OperatorOutput,
  type OperatorTerminalStatus,
} from "./operator-output";

export type StepExecution =
  | Readonly<{
      kind: "verified";
      step: ProvisioningStep;
      resource?: ProvisioningResource | null;
    }>
  | Readonly<{
      kind: "action_required";
      step: ProvisioningStep;
      action: Readonly<{
        kind: string;
        url?: string;
        expiresAt?: string;
      }>;
    }>
  | Readonly<{
      kind: "review_required";
      step: ProvisioningStep;
      code: string;
    }>
  | Readonly<{
      kind: "retryable_failure";
      step: ProvisioningStep;
      code: string;
    }>;

export type CreateFlowRunResult = Readonly<{
  state: CreateFlowState;
  phase: InstallationPhase;
  status: OperatorTerminalStatus;
  exitCode: number;
  report: CreateVerificationReport | null;
  steps: ReadonlyArray<ProvisioningStep>;
  resources: ReadonlyArray<ProvisioningResource>;
}>;

export class CreateFlowRunnerError extends OperatorError {}

/**
 * A runaway guard, not a tuning knob: the catalog is finite, so needing more
 * iterations than it has steps means the selector is not converging.
 */
const maximumStepIterations = 128;

export async function runCreateFlow({
  identity,
  journal,
  output,
  command = "deploy",
  cliVersion,
  planFile,
  planInputHash,
  executeStep,
  verify,
  now,
}: {
  identity: InstallationIdentity;
  journal: ProvisioningJournal;
  output: OperatorOutput;
  command?: ResumableCommand;
  cliVersion: string;
  planFile: string;
  planInputHash: string;
  executeStep: (
    definition: CreateFlowStepDefinition,
    step: ProvisioningStep,
  ) => Promise<StepExecution>;
  verify: () => Promise<CreateVerificationReport>;
  now: () => string;
}): Promise<CreateFlowRunResult> {
  const scope: DeploymentScope = {
    installationId: identity.installationId,
    deploymentId: identity.deploymentId,
    deploymentRole: "target",
  };
  // The first line of the stream is the command envelope, binding every later
  // event to this operation and the exact reviewed plan it executes.
  output.emit({
    event: "command.started",
    ...scope,
    command,
    inputHash: planInputHash,
    cliVersion,
  });

  const finish = async (
    status: OperatorTerminalStatus,
    report: CreateVerificationReport | null,
  ): Promise<CreateFlowRunResult> => {
    const result = await summarize({ journal, status, report });
    if (output.sealed) {
      return summarize({ journal, status: "failed", report });
    }
    output.complete({
      ...scope,
      command,
      status,
      summary: summaryOf(result),
      ...(status === "verified"
        ? {}
        : {
            next: {
              command: resumableCommandLine({
                command,
                planFile,
                json: true,
              }),
            },
          }),
    });
    return result;
  };

  for (let iteration = 0; iteration < maximumStepIterations; iteration += 1) {
    const entries = await journal.listSteps();
    const steps = entries.map((entry) => entry.record);

    // Every recorded step must belong to the plan being executed. A journal
    // holding steps from an earlier plan would otherwise let a newly reviewed
    // account, hostname, release or region inherit work approved under the old
    // one, producing an installation that is a mixture of two approvals.
    const foreignPlanSteps = steps.filter(
      (step) => step.inputHash !== planInputHash,
    );
    if (foreignPlanSteps.length > 0) {
      output.emit({
        event: "warning",
        ...scope,
        code: "plan.journal_bound_to_another_plan",
        stepId: foreignPlanSteps[0]?.stepId,
      });
      return finish("review_required", null);
    }

    const selection = selectNextCreateStep(steps);

    if (selection.kind === "complete") {
      const report = await runVerification({ output, verify, scope });
      if (output.sealed) {
        return summarize({ journal, status: "failed", report });
      }
      return finish(
        report.status === "passed" ? "verified" : "verification_failed",
        report,
      );
    }

    if (selection.kind === "blocked") {
      return finish("review_required", null);
    }

    const definition = selection.definition;
    const existing = entries.find(
      (entry) => entry.record.stepId === definition.stepId,
    );
    const record =
      existing?.record ??
      createProvisioningStep({
        stepId: definition.stepId,
        prerequisites: definition.prerequisites,
        inputHash: planInputHash,
        createdAt: now(),
      });

    const execution = await executeStep(definition, record);
    if (execution.step.stepId !== definition.stepId) {
      throw new CreateFlowRunnerError("create_flow_step_identity_mismatch");
    }

    // A step may only claim `verified` with the evidence its catalog entry
    // demands. Accepting any single check would let a dependant run against a
    // resource whose required protections were never proved.
    if (execution.kind === "verified") {
      const missing = definition.healthCheckIds.filter(
        (checkId) => !execution.step.verifiedChecks.includes(checkId),
      );
      if (missing.length > 0) {
        throw new CreateFlowRunnerError(
          `create_flow_health_evidence_missing:${definition.stepId}:${missing.join(",")}`,
        );
      }
    }

    // The resource row is written first. A crash between the two writes then
    // leaves the step unverified with the provider evidence already recorded,
    // which a resume can reconcile; the reverse order would strand a verified
    // step with no provider ID or ownership evidence behind it.
    if (execution.kind === "verified" && execution.resource != null) {
      const recorded = await journal.readResource(
        execution.resource.provider,
        execution.resource.providerResourceId,
      );
      await journal.putResource(execution.resource, {
        expectedRevision: recorded?.revision ?? 0,
      });
    }

    await journal.putStep(execution.step, {
      expectedRevision: existing?.revision ?? 0,
    });

    output.emit({
      event: "step.changed",
      ...scope,
      stepId: execution.step.stepId,
      status: execution.step.status,
      attempt: execution.step.attempt,
      ...(execution.step.lastStableErrorCode !== null
        ? { code: execution.step.lastStableErrorCode }
        : {}),
    });

    // Emitting credential-shaped material seals the stream and reports a
    // terminal security failure on stdout. Provisioning must stop with it
    // rather than keep writing to client accounts behind a failed stream.
    if (output.sealed) {
      return summarize({ journal, status: "failed", report: null });
    }

    if (execution.kind === "action_required") {
      output.emit({
        event: "action.required",
        ...scope,
        stepId: execution.step.stepId,
        action: execution.action,
      });
      return finish("needs_action", null);
    }

    if (execution.kind === "review_required") {
      return finish("review_required", null);
    }

    if (execution.kind === "retryable_failure") {
      return finish("retryable_failure", null);
    }

  }

  throw new CreateFlowRunnerError("create_flow_did_not_converge");
}

function summaryOf(result: CreateFlowRunResult): {
  passed: number;
  failed: number;
  pending: number;
} {
  const checks = result.report?.checks ?? [];
  return {
    passed:
      result.steps.filter((step) => step.status === "verified").length +
      checks.filter((check) => check.status === "pass").length,
    failed: checks.filter((check) => check.status === "fail").length,
    pending: result.steps.filter((step) => step.status !== "verified").length,
  };
}

async function runVerification({
  output,
  verify,
  scope,
}: {
  output: OperatorOutput;
  verify: () => Promise<CreateVerificationReport>;
  scope: DeploymentScope;
}): Promise<CreateVerificationReport> {
  const report = await verify();
  for (const entry of report.checks) {
    output.emit({
      event: "check.completed",
      ...scope,
      checkId: entry.checkId,
      status: entry.status,
      phase: entry.phase,
      observedAt: entry.observedAt,
      evidenceRef: entry.evidenceRef,
      owner: entry.owner,
      ...(entry.code !== null ? { code: entry.code } : {}),
    });
  }

  return report;
}

async function summarize({
  journal,
  status,
  report,
}: {
  journal: ProvisioningJournal;
  status: OperatorTerminalStatus;
  report: CreateVerificationReport | null;
}): Promise<CreateFlowRunResult> {
  const steps = (await journal.listSteps()).map((entry) => entry.record);
  // Read the inventory back from the journal rather than from this run's
  // accumulator: a resumed invocation must report every resource the
  // installation owns, not only the ones it created itself.
  const resources = (await journal.listResources()).map(
    (entry) => entry.record,
  );
  return Object.freeze({
    state: deriveCreateFlowState(steps),
    phase: deriveInstallationPhase(steps),
    status,
    exitCode: terminalExitCodeFor(status),
    report,
    steps: Object.freeze(steps),
    resources: Object.freeze(resources),
  });
}
