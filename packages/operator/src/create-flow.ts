/**
 * The create flow: the ordered set of steps that turn an approved plan into one
 * client-owned installation, and the phases derived from their verified state.
 *
 * The catalog is data, not control flow. A step advances only when every
 * prerequisite is `verified`, so a dependant can never run against a resource
 * whose readback and health proof have not both passed. Phases are derived from
 * verified steps and are never edited directly.
 */

import { OperatorError } from "./operator-errors";
import type {
  ProvisioningStep,
  ProvisioningStepStatus,
} from "./provisioning-journal";

export type CreateFlowStepId =
  | "preflight"
  | "github.repository"
  | "github.provisioning-state-branch"
  | "github.scaffold-checks"
  | "cloudflare.d1"
  | "cloudflare.r2"
  | "cloudflare.analytics-dataset"
  | "cloudflare.turnstile"
  | "cloudflare.worker.bootstrap"
  | "cloudflare.worker.secrets"
  | "github.publisher-app"
  | "github.upgrade-gate-app"
  | "github.rulesets"
  | "cloudflare.dns"
  | "cloudflare.access"
  | "cloudflare.route"
  | "owner.invitation"
  | "owner.activation"
  | "providers.newsletter"
  | "providers.notifications"
  | "cloudflare.builds"
  | "cloudflare.cron-triggers"
  | "cloudflare.web-analytics"
  | "deployment.promotion"
  | "verification.create";

export type CreateFlowStepDefinition = Readonly<{
  stepId: CreateFlowStepId;
  prerequisites: ReadonlyArray<CreateFlowStepId>;
  /** Whether this step writes to a client provider account. */
  mutatesProvider: boolean;
  /** Health checks that must pass before a dependant may run. */
  healthCheckIds: ReadonlyArray<string>;
}>;

export const createFlowStepCatalog: ReadonlyArray<CreateFlowStepDefinition> =
  Object.freeze([
    {
      stepId: "preflight",
      prerequisites: [],
      mutatesProvider: false,
      healthCheckIds: ["preflight.capabilities", "preflight.quota-margin"],
    },
    {
      stepId: "github.repository",
      prerequisites: ["preflight"],
      mutatesProvider: true,
      healthCheckIds: ["github.repository-marker"],
    },
    {
      stepId: "github.provisioning-state-branch",
      prerequisites: ["github.repository"],
      mutatesProvider: true,
      healthCheckIds: ["github.receipt-chain"],
    },
    {
      stepId: "github.scaffold-checks",
      prerequisites: ["github.provisioning-state-branch"],
      mutatesProvider: false,
      healthCheckIds: ["github.check-suite-succeeded"],
    },
    {
      stepId: "cloudflare.d1",
      prerequisites: ["github.scaffold-checks"],
      mutatesProvider: true,
      healthCheckIds: ["d1.schema-ledger", "d1.transaction-canary"],
    },
    {
      stepId: "cloudflare.r2",
      prerequisites: ["github.scaffold-checks"],
      mutatesProvider: true,
      healthCheckIds: ["r2.private-object-canary", "r2.backup-lifecycle"],
    },
    {
      stepId: "cloudflare.analytics-dataset",
      prerequisites: ["github.scaffold-checks"],
      mutatesProvider: true,
      healthCheckIds: ["analytics.dataset-aggregate"],
    },
    {
      stepId: "cloudflare.turnstile",
      prerequisites: ["github.scaffold-checks"],
      mutatesProvider: true,
      healthCheckIds: ["forms.turnstile-validation"],
    },
    {
      stepId: "cloudflare.worker.bootstrap",
      prerequisites: [
        "cloudflare.d1",
        "cloudflare.r2",
        "cloudflare.analytics-dataset",
        "cloudflare.turnstile",
      ],
      mutatesProvider: true,
      healthCheckIds: ["worker.bindings", "worker.no-public-route"],
    },
    {
      stepId: "cloudflare.worker.secrets",
      prerequisites: ["cloudflare.worker.bootstrap"],
      mutatesProvider: true,
      healthCheckIds: ["secrets.slot-coverage"],
    },
    {
      stepId: "github.publisher-app",
      prerequisites: ["cloudflare.worker.secrets"],
      mutatesProvider: true,
      healthCheckIds: ["github.publisher-token-scope"],
    },
    {
      stepId: "github.upgrade-gate-app",
      prerequisites: ["github.publisher-app"],
      mutatesProvider: true,
      healthCheckIds: ["github.upgrade-gate-check-canary"],
    },
    {
      stepId: "github.rulesets",
      prerequisites: ["github.upgrade-gate-app"],
      mutatesProvider: true,
      healthCheckIds: [
        "github.safety-ruleset",
        "github.workflow-ruleset",
        "github.policy-canary",
      ],
    },
    {
      stepId: "cloudflare.dns",
      prerequisites: ["github.rulesets"],
      mutatesProvider: true,
      healthCheckIds: ["dns.zone-active", "dns.authoritative-record"],
    },
    {
      stepId: "cloudflare.access",
      prerequisites: ["cloudflare.dns"],
      mutatesProvider: true,
      healthCheckIds: ["access.policy-readback", "access.no-broad-rule"],
    },
    {
      stepId: "cloudflare.route",
      prerequisites: ["cloudflare.access"],
      mutatesProvider: true,
      healthCheckIds: ["auth.protected-routes", "auth.no-bypass"],
    },
    {
      stepId: "owner.invitation",
      prerequisites: ["cloudflare.route"],
      mutatesProvider: true,
      healthCheckIds: ["owner.invitation-single-use"],
    },
    {
      stepId: "owner.activation",
      prerequisites: ["owner.invitation"],
      mutatesProvider: false,
      healthCheckIds: ["owner.identity-binding", "owner.bootstrap-closed"],
    },
    {
      stepId: "providers.newsletter",
      prerequisites: ["owner.activation"],
      mutatesProvider: true,
      healthCheckIds: ["newsletter.provider-health"],
    },
    {
      stepId: "providers.notifications",
      prerequisites: ["owner.activation"],
      mutatesProvider: true,
      healthCheckIds: [
        "forms.notification-binding",
        "forms.notification-synthetic",
        "forms.notification-real-receipt",
      ],
    },
    {
      stepId: "cloudflare.builds",
      prerequisites: ["owner.activation"],
      mutatesProvider: true,
      healthCheckIds: ["builds.repository-connection", "builds.canary-commit"],
    },
    {
      stepId: "cloudflare.cron-triggers",
      prerequisites: ["cloudflare.builds"],
      mutatesProvider: true,
      healthCheckIds: [
        "scheduler.trigger-registered",
        "scheduler.fresh-heartbeat",
        "scheduler.single-claim",
      ],
    },
    {
      stepId: "cloudflare.web-analytics",
      prerequisites: ["cloudflare.builds"],
      mutatesProvider: true,
      healthCheckIds: ["analytics.beacon-delivery"],
    },
    {
      stepId: "deployment.promotion",
      prerequisites: [
        "cloudflare.builds",
        "cloudflare.cron-triggers",
        "cloudflare.web-analytics",
        "providers.newsletter",
        "providers.notifications",
      ],
      mutatesProvider: true,
      healthCheckIds: ["deployment.release-marker", "deployment.alias-disabled"],
    },
    {
      stepId: "verification.create",
      prerequisites: ["deployment.promotion"],
      mutatesProvider: false,
      healthCheckIds: [
        "site.public-reference",
        "auth.dash-protected",
        "publication.attributed-live",
        "independence.no-maintainer-authority",
      ],
    },
  ] as const);

export const createFlowStates = Object.freeze([
  "planned",
  "preflighted",
  "repository_ready",
  "resources_ready",
  "runtime_bound",
  "access_ready",
  "owner_claimable",
  "owner_active",
  "deployment_ready",
  "verification_ready",
] as const);

export type CreateFlowState = (typeof createFlowStates)[number];

/**
 * The full documented installation-phase vocabulary. `handoff_ready` and
 * `handed_off` are reached by the handoff flow and `degraded` by a later failed
 * health check; the create flow derives phases only up to `verification_ready`,
 * so those three are declared here but never returned by
 * `deriveInstallationPhase`.
 */
export const installationPhases = Object.freeze([
  "discovered",
  "preflight_ready",
  "repository_ready",
  "cloudflare_resources_ready",
  "runtime_bound",
  "access_ready",
  "owner_claimable",
  "owner_active",
  "deployment_ready",
  "verification_ready",
  "handoff_ready",
  "handed_off",
  "degraded",
] as const);

export type InstallationPhase = (typeof installationPhases)[number];

export const createFlowDerivablePhases: ReadonlyArray<InstallationPhase> =
  Object.freeze(installationPhases.slice(0, 10));

const createFlowStateRequirements: Readonly<
  Record<CreateFlowState, ReadonlyArray<CreateFlowStepId>>
> = Object.freeze({
  planned: [],
  preflighted: ["preflight"],
  repository_ready: [
    "github.repository",
    "github.provisioning-state-branch",
    "github.scaffold-checks",
  ],
  resources_ready: [
    "cloudflare.d1",
    "cloudflare.r2",
    "cloudflare.analytics-dataset",
    "cloudflare.turnstile",
  ],
  runtime_bound: [
    "cloudflare.worker.bootstrap",
    "cloudflare.worker.secrets",
    "github.publisher-app",
    "github.upgrade-gate-app",
    "github.rulesets",
  ],
  access_ready: ["cloudflare.dns", "cloudflare.access"],
  owner_claimable: ["cloudflare.route", "owner.invitation"],
  owner_active: ["owner.activation"],
  deployment_ready: [
    "providers.newsletter",
    "providers.notifications",
    "cloudflare.builds",
    "cloudflare.cron-triggers",
    "cloudflare.web-analytics",
    "deployment.promotion",
  ],
  verification_ready: ["verification.create"],
});

/**
 * Installation phases and create-flow states describe the same progress from
 * two angles: the phase names the installation's durable condition, the state
 * names where the `deploy` command is in its own workflow.
 */
const phaseForState: Readonly<Record<CreateFlowState, InstallationPhase>> =
  Object.freeze({
    planned: "discovered",
    preflighted: "preflight_ready",
    repository_ready: "repository_ready",
    resources_ready: "cloudflare_resources_ready",
    runtime_bound: "runtime_bound",
    access_ready: "access_ready",
    owner_claimable: "owner_claimable",
    owner_active: "owner_active",
    deployment_ready: "deployment_ready",
    verification_ready: "verification_ready",
  });

export class CreateFlowError extends OperatorError {}

export function createFlowStep(stepId: CreateFlowStepId): CreateFlowStepDefinition {
  const definition = createFlowStepCatalog.find(
    (candidate) => candidate.stepId === stepId,
  );
  if (definition === undefined) {
    throw new CreateFlowError("create_flow_step_unknown");
  }
  return definition;
}

function statusByStepId(
  steps: ReadonlyArray<ProvisioningStep>,
): ReadonlyMap<string, ProvisioningStepStatus> {
  return new Map(steps.map((step) => [step.stepId, step.status]));
}

export function deriveCreateFlowState(
  steps: ReadonlyArray<ProvisioningStep>,
): CreateFlowState {
  const statuses = statusByStepId(steps);
  let reached: CreateFlowState = "planned";
  for (const state of createFlowStates) {
    const satisfied = createFlowStateRequirements[state].every(
      (stepId) => statuses.get(stepId) === "verified",
    );
    if (!satisfied) {
      return reached;
    }
    reached = state;
  }
  return reached;
}

export function deriveInstallationPhase(
  steps: ReadonlyArray<ProvisioningStep>,
): InstallationPhase {
  return phaseForState[deriveCreateFlowState(steps)];
}

export type NextStepSelection =
  | Readonly<{ kind: "step"; definition: CreateFlowStepDefinition }>
  | Readonly<{ kind: "blocked"; stepId: CreateFlowStepId; reason: string }>
  | Readonly<{ kind: "complete" }>;

/**
 * Chooses the next step to run. A step whose prerequisite is not verified is
 * never selected, and a prerequisite that failed terminally or needs a client
 * action is reported rather than skipped.
 */
export function selectNextCreateStep(
  steps: ReadonlyArray<ProvisioningStep>,
): NextStepSelection {
  const statuses = statusByStepId(steps);

  for (const definition of createFlowStepCatalog) {
    if (statuses.get(definition.stepId) === "verified") {
      continue;
    }
    const unmet = definition.prerequisites.filter(
      (stepId) => statuses.get(stepId) !== "verified",
    );
    if (unmet.length === 0) {
      const status = statuses.get(definition.stepId);
      // A step the journal already recorded as blocked stays blocked: only the
      // documented `blocked -> not_started` resolution puts it back in play.
      if (
        status === "failed_terminal" ||
        status === "manual_action_required" ||
        status === "blocked"
      ) {
        return Object.freeze({
          kind: "blocked" as const,
          stepId: definition.stepId,
          reason: status,
        });
      }
      return Object.freeze({ kind: "step" as const, definition });
    }
    const blockingStatus = unmet
      .map((stepId) => statuses.get(stepId))
      .find(
        (status) =>
          status === "failed_terminal" ||
          status === "manual_action_required" ||
          status === "blocked",
      );
    if (blockingStatus !== undefined) {
      return Object.freeze({
        kind: "blocked" as const,
        stepId: definition.stepId,
        reason: blockingStatus,
      });
    }
  }

  return Object.freeze({ kind: "complete" as const });
}

export function assertPrerequisitesVerified(
  stepId: CreateFlowStepId,
  steps: ReadonlyArray<ProvisioningStep>,
): void {
  const statuses = statusByStepId(steps);
  const unmet = createFlowStep(stepId).prerequisites.filter(
    (prerequisite) => statuses.get(prerequisite) !== "verified",
  );
  if (unmet.length > 0) {
    throw new CreateFlowError(
      `create_flow_prerequisite_unverified:${unmet.join(",")}`,
    );
  }
}

/**
 * Every step in the catalog must be reachable and every prerequisite must be
 * declared before it is used, so an ordering mistake fails here rather than
 * halfway through a client account.
 */
export function assertCreateFlowCatalogIsWellOrdered(): void {
  const seen = new Set<string>();
  for (const definition of createFlowStepCatalog) {
    if (seen.has(definition.stepId)) {
      throw new CreateFlowError("create_flow_step_duplicated");
    }
    for (const prerequisite of definition.prerequisites) {
      if (!seen.has(prerequisite)) {
        throw new CreateFlowError(
          `create_flow_prerequisite_out_of_order:${definition.stepId}`,
        );
      }
    }
    seen.add(definition.stepId);
  }

  for (const state of createFlowStates) {
    for (const stepId of createFlowStateRequirements[state]) {
      if (!seen.has(stepId)) {
        throw new CreateFlowError(`create_flow_state_step_unknown:${state}`);
      }
    }
  }

  const covered = new Set(
    createFlowStates.flatMap((state) => [...createFlowStateRequirements[state]]),
  );
  for (const definition of createFlowStepCatalog) {
    if (!covered.has(definition.stepId)) {
      throw new CreateFlowError(
        `create_flow_step_uncovered:${definition.stepId}`,
      );
    }
  }
}
