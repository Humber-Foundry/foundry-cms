/**
 * Reviewed, input-hash-bound operator plans.
 *
 * `scaffold --plan` and `deploy --plan-file` are two halves of one approval: a
 * plan states exactly which account, hostname, release and region the operator
 * reviewed, and its hash binds that approval. Changing any of those inputs
 * invalidates the plan rather than silently provisioning something else.
 */

import {
  assertNonSecretConfiguration,
  computeConfigurationFingerprint,
  fingerprintPattern,
  type ConfigurationFingerprint,
} from "./configuration-fingerprint";
import { isUuidV7 } from "./installation-identity";
import { operatorCommands } from "./operator-cli";
import { OperatorError } from "./operator-errors";
import type { OperatorCommand } from "./operator-output";

export const operatorPlanSchemaVersion = "foundry.operator-plan/v1";

/**
 * The inputs whose change must invalidate an approved plan. Every one of them
 * decides which client account, name or code an operation would write to.
 */
export const approvalBindingInputs = Object.freeze([
  "githubOwner",
  "githubRepository",
  "productionBranch",
  "cloudflareAccountScopeFingerprint",
  "githubAccountScopeFingerprint",
  "canonicalHostname",
  "foundationReleaseVersion",
  "foundationReleaseDigest",
  "dataRegion",
  "repositoryVisibility",
] as const);

export type ApprovalBindingInput = (typeof approvalBindingInputs)[number];

export type OperatorPlanInputs = Readonly<
  Record<ApprovalBindingInput, string>
>;

export type OperatorPlan = Readonly<{
  schemaVersion: string;
  command: OperatorCommand;
  installationId: string;
  deploymentId: string;
  inputHash: ConfigurationFingerprint;
  inputs: OperatorPlanInputs;
  createdAt: string;
  cliVersion: string;
}>;

export class OperatorPlanError extends OperatorError {}

function normalizeInputs(inputs: unknown): OperatorPlanInputs {
  if (typeof inputs !== "object" || inputs === null) {
    throw new OperatorPlanError("plan_inputs_invalid");
  }
  const source = inputs as Record<string, unknown>;
  const normalized: Record<string, string> = {};
  for (const field of approvalBindingInputs) {
    const value = source[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new OperatorPlanError(`plan_input_missing:${field}`);
    }
    normalized[field] = value.trim();
  }
  const unexpected = Object.keys(source).filter(
    (field) =>
      !(approvalBindingInputs as ReadonlyArray<string>).includes(field),
  );
  if (unexpected.length > 0) {
    throw new OperatorPlanError(`plan_input_unexpected:${unexpected.join(",")}`);
  }
  assertNonSecretConfiguration(normalized);
  return Object.freeze(normalized) as OperatorPlanInputs;
}

/**
 * The approval hash covers the command and both identities as well as the
 * reviewed inputs. Leaving them out would let an edited plan keep its hash while
 * pointing at another installation, deployment or operation.
 */
export async function computePlanInputHash({
  command,
  installationId,
  deploymentId,
  inputs,
}: {
  command: OperatorCommand;
  installationId: string;
  deploymentId: string;
  inputs: OperatorPlanInputs;
}): Promise<ConfigurationFingerprint> {
  return computeConfigurationFingerprint({
    schemaVersion: operatorPlanSchemaVersion,
    command,
    installationId,
    deploymentId,
    inputs,
  });
}

export async function createOperatorPlan({
  command,
  installationId,
  deploymentId,
  inputs,
  createdAt,
  cliVersion,
}: {
  command: OperatorCommand;
  installationId: string;
  deploymentId: string;
  inputs: unknown;
  createdAt: string;
  cliVersion: string;
}): Promise<OperatorPlan> {
  if (!isUuidV7(installationId) || !isUuidV7(deploymentId)) {
    throw new OperatorPlanError("plan_identity_invalid");
  }
  if (installationId.toLowerCase() === deploymentId.toLowerCase()) {
    throw new OperatorPlanError("plan_identity_invalid");
  }
  const normalized = normalizeInputs(inputs);
  if (!(operatorCommands as ReadonlyArray<string>).includes(command)) {
    throw new OperatorPlanError("plan_command_unknown");
  }

  return Object.freeze({
    schemaVersion: operatorPlanSchemaVersion,
    command,
    installationId: installationId.toLowerCase(),
    deploymentId: deploymentId.toLowerCase(),
    inputHash: await computePlanInputHash({
      command,
      installationId: installationId.toLowerCase(),
      deploymentId: deploymentId.toLowerCase(),
      inputs: normalized,
    }),
    inputs: normalized,
    createdAt,
    cliVersion,
  });
}

export function serializeOperatorPlan(plan: OperatorPlan): string {
  assertNonSecretConfiguration(plan);
  return `${JSON.stringify(plan, null, 2)}\n`;
}

export async function parseOperatorPlan(source: string): Promise<OperatorPlan> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new OperatorPlanError("plan_unparsable");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new OperatorPlanError("plan_unparsable");
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.schemaVersion !== operatorPlanSchemaVersion) {
    throw new OperatorPlanError("plan_schema_incompatible");
  }
  if (
    typeof candidate.inputHash !== "string" ||
    !fingerprintPattern.test(candidate.inputHash)
  ) {
    throw new OperatorPlanError("plan_input_hash_invalid");
  }

  const plan = await createOperatorPlan({
    command: candidate.command as OperatorCommand,
    installationId: String(candidate.installationId),
    deploymentId: String(candidate.deploymentId),
    inputs: candidate.inputs,
    createdAt: String(candidate.createdAt),
    cliVersion: String(candidate.cliVersion),
  });

  // A plan that does not hash to its own recorded value was edited after
  // review, so the approval it carries is not the approval it claims.
  if (plan.inputHash !== candidate.inputHash) {
    throw new OperatorPlanError("plan_input_hash_mismatch");
  }
  return plan;
}

/**
 * Re-checks a reviewed plan against the inputs observed now. Execution requires
 * the plan hash, so a changed account, hostname, release or region stops the
 * operation instead of provisioning something the operator never approved.
 */
export async function assertPlanStillApplies({
  plan,
  observedInputs,
}: {
  plan: OperatorPlan;
  observedInputs: unknown;
}): Promise<void> {
  const normalized = normalizeInputs(observedInputs);
  const changed = approvalBindingInputs.filter(
    (field) => plan.inputs[field] !== normalized[field],
  );
  if (changed.length > 0) {
    throw new OperatorPlanError(`plan_inputs_changed:${changed.join(",")}`);
  }
  const recomputed = await computePlanInputHash({
    command: plan.command,
    installationId: plan.installationId,
    deploymentId: plan.deploymentId,
    inputs: normalized,
  });
  if (recomputed !== plan.inputHash) {
    throw new OperatorPlanError("plan_input_hash_mismatch");
  }
}
