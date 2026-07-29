/**
 * The provisioning journal: durable step and resource state for one
 * installation.
 *
 * A step never records success from a provider response alone. `applying` is
 * only ever an in-flight marker — a restart demotes it to `applied_unverified`
 * so the next action reconciles before it writes again. A resource row keeps
 * both the logical installation and the account-bound deployment so discovery
 * can never match a resource belonging to a superseded set.
 */

import { fingerprintPattern } from "./configuration-fingerprint";
import { OperatorError, requireText } from "./operator-errors";
import { containsCredentialMaterial } from "./secret-material";

export const provisioningStepStatuses = Object.freeze([
  "not_started",
  "blocked",
  "applying",
  "applied_unverified",
  "verified",
  "failed_retryable",
  "failed_terminal",
  "manual_action_required",
  "compensating",
  "rolled_back",
] as const);

export type ProvisioningStepStatus =
  (typeof provisioningStepStatuses)[number];

const allowedTransitions: Readonly<
  Record<ProvisioningStepStatus, ReadonlyArray<ProvisioningStepStatus>>
> = Object.freeze({
  not_started: ["blocked", "applying"],
  blocked: ["not_started"],
  applying: ["applied_unverified", "failed_retryable", "failed_terminal"],
  applied_unverified: [
    "verified",
    "failed_retryable",
    "manual_action_required",
    "compensating",
  ],
  verified: ["applied_unverified", "compensating"],
  failed_retryable: ["applying"],
  // Only a newly reviewed plan returns a terminal failure to the start.
  failed_terminal: ["not_started"],
  manual_action_required: ["applied_unverified"],
  compensating: ["rolled_back"],
  rolled_back: ["applying"],
});

export type ResourceLifecycle =
  | "active"
  | "disabled"
  | "quarantined"
  | "superseded";

export type ProvisioningStep = Readonly<{
  stepId: string;
  prerequisites: ReadonlyArray<string>;
  inputHash: string;
  status: ProvisioningStepStatus;
  attempt: number;
  providerRequestId: string | null;
  lastStableErrorCode: string | null;
  verifiedChecks: ReadonlyArray<string>;
  createdAt: string;
  updatedAt: string;
}>;

export type ProvisioningResource = Readonly<{
  installationId: string;
  deploymentId: string;
  provider: string;
  resourceKind: string;
  providerResourceId: string;
  displayName: string;
  ownershipPrincipal: string;
  createdByOperationId: string;
  adopted: boolean;
  desiredFingerprint: string;
  observedFingerprint: string | null;
  lastVerifiedAt: string | null;
  lifecycle: ResourceLifecycle;
}>;

export class ProvisioningStepError extends OperatorError {}

export class ProvisioningResourceError extends OperatorError {}

export class JournalConflictError extends OperatorError {
  readonly currentRevision: number;

  constructor(currentRevision: number) {
    super("journal_revision_conflict");
    this.currentRevision = currentRevision;
  }
}

function requiredText(
  value: unknown,
  code: string,
  ErrorType: typeof ProvisioningStepError | typeof ProvisioningResourceError,
): string {
  return requireText(value, code, (reason) => new ErrorType(reason));
}

export function isAllowedStepTransition(
  from: ProvisioningStepStatus,
  to: ProvisioningStepStatus,
): boolean {
  return (allowedTransitions[from] ?? []).includes(to);
}

export function createProvisioningStep({
  stepId,
  prerequisites = [],
  inputHash,
  createdAt,
}: {
  stepId: string;
  prerequisites?: ReadonlyArray<string>;
  inputHash: string;
  createdAt: string;
}): ProvisioningStep {
  if (!fingerprintPattern.test(inputHash)) {
    throw new ProvisioningStepError("step_input_hash_invalid");
  }
  return Object.freeze({
    stepId: requiredText(stepId, "step_id_invalid", ProvisioningStepError),
    prerequisites: Object.freeze([...prerequisites]),
    inputHash,
    status: "not_started" as const,
    attempt: 0,
    providerRequestId: null,
    lastStableErrorCode: null,
    verifiedChecks: Object.freeze([]),
    createdAt: requiredText(
      createdAt,
      "step_created_at_invalid",
      ProvisioningStepError,
    ),
    updatedAt: createdAt,
  });
}

export function transitionStep(
  record: ProvisioningStep,
  {
    status,
    at,
    code = null,
    providerRequestId,
    verifiedChecks,
    correctedPlanInputHash,
  }: {
    status: ProvisioningStepStatus;
    at: string;
    code?: string | null;
    providerRequestId?: string;
    verifiedChecks?: ReadonlyArray<string>;
    correctedPlanInputHash?: string;
  },
): ProvisioningStep {
  if (!isAllowedStepTransition(record.status, status)) {
    throw new ProvisioningStepError(
      `step_transition_refused:${record.status}->${status}`,
    );
  }
  if (providerRequestId !== undefined) {
    if (containsCredentialMaterial(providerRequestId)) {
      throw new ProvisioningStepError("step_provider_request_id_unsafe");
    }
    requiredText(
      providerRequestId,
      "step_provider_request_id_invalid",
      ProvisioningStepError,
    );
  }

  let inputHash = record.inputHash;
  if (record.status === "failed_terminal") {
    if (
      correctedPlanInputHash === undefined ||
      !fingerprintPattern.test(correctedPlanInputHash)
    ) {
      throw new ProvisioningStepError("step_corrected_plan_required");
    }
    if (correctedPlanInputHash === record.inputHash) {
      throw new ProvisioningStepError("step_corrected_plan_unchanged");
    }
    inputHash = correctedPlanInputHash;
  } else if (correctedPlanInputHash !== undefined) {
    throw new ProvisioningStepError("step_corrected_plan_unexpected");
  }

  if (status === "verified") {
    const checks = verifiedChecks ?? record.verifiedChecks;
    if (checks.length === 0) {
      throw new ProvisioningStepError("step_verification_evidence_required");
    }
  }

  return Object.freeze({
    ...record,
    inputHash,
    status,
    attempt: status === "applying" ? record.attempt + 1 : record.attempt,
    providerRequestId: providerRequestId ?? record.providerRequestId,
    lastStableErrorCode: code ?? record.lastStableErrorCode,
    verifiedChecks: Object.freeze([
      ...(verifiedChecks ?? record.verifiedChecks),
    ]),
    updatedAt: requiredText(at, "step_time_invalid", ProvisioningStepError),
  });
}

/**
 * `applying` is never evidence that a write landed. A process that dies mid
 * apply leaves a step that must be reconciled against the provider before any
 * further write, so restart demotes it rather than retrying blindly.
 */
export function reconcileStepsAfterRestart(
  records: ReadonlyArray<ProvisioningStep>,
  { at }: { at: string },
): ReadonlyArray<ProvisioningStep> {
  return records.map((record) =>
    record.status === "applying"
      ? transitionStep(record, { status: "applied_unverified", at })
      : record,
  );
}

export function createProvisioningResource({
  installationId,
  deploymentId,
  provider,
  resourceKind,
  providerResourceId,
  displayName,
  ownershipPrincipal,
  createdByOperationId,
  adopted,
  desiredFingerprint,
  lifecycle = "active",
}: {
  installationId: string;
  deploymentId: string;
  provider: string;
  resourceKind: string;
  providerResourceId: string;
  displayName: string;
  ownershipPrincipal: string;
  createdByOperationId: string;
  adopted: boolean;
  desiredFingerprint: string;
  lifecycle?: ResourceLifecycle;
  createdAt?: string;
}): ProvisioningResource {
  const record = {
    installationId: requiredText(
      installationId,
      "resource_installation_invalid",
      ProvisioningResourceError,
    ).toLowerCase(),
    deploymentId: requiredText(
      deploymentId,
      "resource_deployment_invalid",
      ProvisioningResourceError,
    ).toLowerCase(),
    provider: requiredText(
      provider,
      "resource_provider_invalid",
      ProvisioningResourceError,
    ),
    resourceKind: requiredText(
      resourceKind,
      "resource_kind_invalid",
      ProvisioningResourceError,
    ),
    providerResourceId: requiredText(
      providerResourceId,
      "resource_provider_id_invalid",
      ProvisioningResourceError,
    ),
    displayName: requiredText(
      displayName,
      "resource_display_name_invalid",
      ProvisioningResourceError,
    ),
    ownershipPrincipal: requiredText(
      ownershipPrincipal,
      "resource_ownership_principal_invalid",
      ProvisioningResourceError,
    ),
    createdByOperationId: requiredText(
      createdByOperationId,
      "resource_operation_invalid",
      ProvisioningResourceError,
    ),
    adopted,
    desiredFingerprint,
    observedFingerprint: null,
    lastVerifiedAt: null,
    lifecycle,
  };

  if (record.installationId === record.deploymentId) {
    throw new ProvisioningResourceError("resource_deployment_not_distinct");
  }
  if (!fingerprintPattern.test(desiredFingerprint)) {
    throw new ProvisioningResourceError("resource_desired_fingerprint_invalid");
  }
  if (containsCredentialMaterial(record)) {
    throw new ProvisioningResourceError("resource_record_unsafe");
  }

  return Object.freeze(record);
}

export function observeResource(
  record: ProvisioningResource,
  {
    observedFingerprint,
    observedAt,
    lifecycle,
  }: {
    observedFingerprint: string;
    observedAt: string;
    lifecycle?: ResourceLifecycle;
  },
): ProvisioningResource {
  if (!fingerprintPattern.test(observedFingerprint)) {
    throw new ProvisioningResourceError(
      "resource_observed_fingerprint_invalid",
    );
  }
  const matches = observedFingerprint === record.desiredFingerprint;
  return Object.freeze({
    ...record,
    observedFingerprint,
    lastVerifiedAt: matches ? observedAt : null,
    lifecycle: lifecycle ?? record.lifecycle,
  });
}

export type JournalEntry<T> = Readonly<{ record: T; revision: number }>;

export type ProvisioningJournal = Readonly<{
  putStep(
    record: ProvisioningStep,
    options: { expectedRevision: number },
  ): Promise<JournalEntry<ProvisioningStep>>;
  readStep(stepId: string): Promise<JournalEntry<ProvisioningStep> | null>;
  listSteps(): Promise<ReadonlyArray<JournalEntry<ProvisioningStep>>>;
  putResource(
    record: ProvisioningResource,
    options: { expectedRevision: number },
  ): Promise<JournalEntry<ProvisioningResource>>;
  readResource(
    provider: string,
    providerResourceId: string,
  ): Promise<JournalEntry<ProvisioningResource> | null>;
  listResources(): Promise<ReadonlyArray<JournalEntry<ProvisioningResource>>>;
}>;

function compareAndSwap<T>(
  store: Map<string, JournalEntry<T>>,
  key: string,
  record: T,
  expectedRevision: number,
): JournalEntry<T> {
  const current = store.get(key);
  const currentRevision = current?.revision ?? 0;
  if (currentRevision !== expectedRevision) {
    throw new JournalConflictError(currentRevision);
  }
  const entry = Object.freeze({ record, revision: currentRevision + 1 });
  store.set(key, entry);
  return entry;
}

export function createInMemoryProvisioningJournal(): ProvisioningJournal {
  const steps = new Map<string, JournalEntry<ProvisioningStep>>();
  const resources = new Map<string, JournalEntry<ProvisioningResource>>();

  return Object.freeze({
    async putStep(record, { expectedRevision }) {
      return compareAndSwap(steps, record.stepId, record, expectedRevision);
    },
    async readStep(stepId) {
      return steps.get(stepId) ?? null;
    },
    async listSteps() {
      return Object.freeze([...steps.values()]);
    },
    async putResource(record, { expectedRevision }) {
      return compareAndSwap(
        resources,
        `${record.provider}:${record.providerResourceId}`,
        record,
        expectedRevision,
      );
    },
    async readResource(provider, providerResourceId) {
      return resources.get(`${provider}:${providerResourceId}`) ?? null;
    },
    async listResources() {
      return Object.freeze([...resources.values()]);
    },
  });
}
