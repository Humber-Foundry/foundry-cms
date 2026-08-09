/**
 * Reconciliation: inspect, plan, apply, verify.
 *
 * Create is reconciliation, not a one-shot write. Every step reads the client's
 * account back before it decides anything, creates only what it has proved
 * absent, and refuses to advance a dependant until a readback and a health
 * check agree with the intent. A matching name is never treated as proof of
 * ownership; only an installation marker, a recorded provider ID, or a
 * conclusive create-request binding can adopt a resource.
 */

import { canonicalJson } from "@humber-foundry/application";

import {
  computeConfigurationFingerprint,
  fingerprintPattern,
  fingerprintsMatch,
  InvalidConfigurationError,
  type ConfigurationFingerprint,
} from "./configuration-fingerprint";
import type { InstallationIdentity } from "./installation-identity";
import type { ResourceCreateIntentLog } from "./provisioning-receipts";
import { OperatorError } from "./operator-errors";
import {
  createProvisioningResource,
  observeResource,
  transitionStep,
  type ProvisioningResource,
  type ProvisioningStep,
} from "./provisioning-journal";

export type ResourceClassification =
  | "absent"
  | "exact"
  | "repairable_drift"
  | "incompatible_drift"
  | "ambiguous"
  | "foreign";

export type ProviderResourceCandidate = Readonly<{
  providerResourceId: string;
  displayName: string;
  installationMarker: string | null;
  deploymentMarker: string | null;
  configuration: unknown;
  createdAt: string | null;
  createRequestId: string | null;
}>;

export type ResourceObservation = Readonly<{
  classification: ResourceClassification;
  candidate: ProviderResourceCandidate | null;
  candidates: ReadonlyArray<ProviderResourceCandidate>;
  observedFingerprint: ConfigurationFingerprint | null;
  drift: ReadonlyArray<string>;
}>;

export type ResourceCreateIntent = Readonly<{
  provider: string;
  resourceKind: string;
  resourceName: string;
  operationId: string;
  installationId: string;
  deploymentId: string;
  accountScopeFingerprint: ConfigurationFingerprint;
  desiredFingerprint: ConfigurationFingerprint;
  notBefore: string;
  notAfter: string;
  nonce: string;
}>;

export class ReconciliationReviewRequiredError extends OperatorError {
  readonly classification: ResourceClassification | "adoption_refused";

  readonly step: ProvisioningStep;

  readonly observation: ResourceObservation | null;

  constructor({
    code,
    classification,
    step,
    observation = null,
  }: {
    code: string;
    classification: ResourceClassification | "adoption_refused";
    step: ProvisioningStep;
    observation?: ResourceObservation | null;
  }) {
    super(code);
    this.classification = classification;
    this.step = step;
    this.observation = observation;
  }
}

export class CreateIntentError extends OperatorError {}

function configurationEntries(value: unknown): Map<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return new Map();
  }
  return new Map(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      canonicalJson(entry),
    ]),
  );
}

function driftedFields(desired: unknown, observed: unknown): ReadonlyArray<string> {
  const left = configurationEntries(desired);
  const right = configurationEntries(observed);
  const fields = new Set([...left.keys(), ...right.keys()]);
  return [...fields]
    .filter((field) => left.get(field) !== right.get(field))
    .sort();
}

function isEmptyConfiguration(value: unknown): boolean {
  return configurationEntries(value).size === 0;
}

export async function classifyResourceObservation({
  identity,
  desiredConfiguration,
  desiredFingerprint,
  candidates,
  repairableFields,
}: {
  identity: InstallationIdentity;
  desiredConfiguration: unknown;
  desiredFingerprint: ConfigurationFingerprint;
  candidates: ReadonlyArray<ProviderResourceCandidate>;
  repairableFields: ReadonlyArray<string>;
}): Promise<ResourceObservation> {
  const observed = Object.freeze([...candidates]);

  if (observed.length === 0) {
    return Object.freeze({
      classification: "absent" as const,
      candidate: null,
      candidates: observed,
      observedFingerprint: null,
      drift: Object.freeze([]),
    });
  }

  // More than one candidate cannot be resolved by inspection alone: adopting
  // either would be a guess about which resource this installation owns.
  if (observed.length > 1) {
    return Object.freeze({
      classification: "ambiguous" as const,
      candidate: null,
      candidates: observed,
      observedFingerprint: null,
      drift: Object.freeze([]),
    });
  }

  const [only] = observed as [ProviderResourceCandidate];
  const marksAnotherInstallation =
    (only.installationMarker !== null &&
      only.installationMarker.toLowerCase() !== identity.installationId) ||
    (only.deploymentMarker !== null &&
      only.deploymentMarker.toLowerCase() !== identity.deploymentId);

  if (marksAnotherInstallation) {
    return Object.freeze({
      classification: "foreign" as const,
      candidate: only,
      candidates: observed,
      observedFingerprint: null,
      drift: Object.freeze([]),
    });
  }

  if (only.installationMarker === null || only.deploymentMarker === null) {
    return Object.freeze({
      classification: "ambiguous" as const,
      candidate: only,
      candidates: observed,
      observedFingerprint: null,
      drift: Object.freeze([]),
    });
  }

  let observedFingerprint: ConfigurationFingerprint | null = null;
  try {
    observedFingerprint = await computeConfigurationFingerprint(
      only.configuration,
    );
  } catch (error) {
    if (!(error instanceof InvalidConfigurationError)) {
      throw error;
    }
  }

  if (
    observedFingerprint !== null &&
    fingerprintsMatch(observedFingerprint, desiredFingerprint)
  ) {
    return Object.freeze({
      classification: "exact" as const,
      candidate: only,
      candidates: observed,
      observedFingerprint,
      drift: Object.freeze([]),
    });
  }

  const drift = driftedFields(desiredConfiguration, only.configuration);
  const repairable =
    drift.length > 0 &&
    drift.every((field) => repairableFields.includes(field));

  return Object.freeze({
    classification: repairable
      ? ("repairable_drift" as const)
      : ("incompatible_drift" as const),
    candidate: only,
    candidates: observed,
    observedFingerprint,
    drift: Object.freeze(drift),
  });
}

export async function createResourceCreateIntent({
  identity,
  provider,
  resourceKind,
  resourceName,
  operationId,
  accountScopeFingerprint,
  desiredFingerprint,
  notBefore,
  operationWindowSeconds,
  nonce,
  preflightProvedAbsent,
}: {
  identity: InstallationIdentity;
  provider: string;
  resourceKind: string;
  resourceName: string;
  operationId: string;
  accountScopeFingerprint: ConfigurationFingerprint;
  desiredFingerprint: ConfigurationFingerprint;
  notBefore: string;
  operationWindowSeconds: number;
  nonce: string;
  preflightProvedAbsent: boolean;
}): Promise<ResourceCreateIntent> {
  if (!preflightProvedAbsent) {
    throw new CreateIntentError("create_intent_absence_unproved");
  }
  if (
    !fingerprintPattern.test(accountScopeFingerprint) ||
    !fingerprintPattern.test(desiredFingerprint)
  ) {
    throw new CreateIntentError("create_intent_fingerprint_invalid");
  }
  if (!/^[0-9a-f]{32}$/u.test(nonce)) {
    throw new CreateIntentError("create_intent_nonce_invalid");
  }
  const start = Date.parse(notBefore);
  if (!Number.isFinite(start)) {
    throw new CreateIntentError("create_intent_not_before_invalid");
  }
  if (
    !Number.isSafeInteger(operationWindowSeconds) ||
    operationWindowSeconds <= 0
  ) {
    throw new CreateIntentError("create_intent_window_invalid");
  }

  return Object.freeze({
    provider,
    resourceKind,
    resourceName,
    operationId,
    installationId: identity.installationId,
    deploymentId: identity.deploymentId,
    accountScopeFingerprint,
    desiredFingerprint,
    notBefore: new Date(start).toISOString(),
    notAfter: new Date(start + operationWindowSeconds * 1000).toISOString(),
    nonce,
  });
}

export type AdoptionDecision = Readonly<{
  adopted: boolean;
  code: string;
  candidate: ProviderResourceCandidate | null;
}>;

function refuseAdoption(
  code: string,
  candidate: ProviderResourceCandidate | null = null,
): AdoptionDecision {
  return Object.freeze({ adopted: false, code, candidate });
}

/**
 * Automatic adoption after an ambiguous write requires a conclusive provider
 * binding to this operation plus every corroborating fact. Name, time and
 * configuration correlation alone never prove ownership.
 */
export async function evaluateCreateIntentAdoption({
  intent,
  candidates,
  intentCommitted,
  accountScopeFingerprint,
  laterConflictingIntentExists,
}: {
  intent: ResourceCreateIntent;
  candidates: ReadonlyArray<ProviderResourceCandidate>;
  intentCommitted: boolean;
  accountScopeFingerprint: ConfigurationFingerprint;
  laterConflictingIntentExists: boolean;
}): Promise<AdoptionDecision> {
  if (!intentCommitted) {
    return refuseAdoption("adoption.intent_not_committed");
  }
  if (
    !fingerprintsMatch(accountScopeFingerprint, intent.accountScopeFingerprint)
  ) {
    return refuseAdoption("adoption.account_scope_mismatch");
  }
  if (laterConflictingIntentExists) {
    return refuseAdoption("adoption.later_conflicting_intent");
  }
  if (candidates.length === 0) {
    return refuseAdoption("adoption.no_candidate");
  }
  if (candidates.length > 1) {
    return refuseAdoption("adoption.multiple_candidates");
  }

  const [only] = candidates as [ProviderResourceCandidate];
  if (only.displayName !== intent.resourceName) {
    return refuseAdoption("adoption.name_mismatch", only);
  }
  if (only.createRequestId === null || only.createRequestId.length === 0) {
    return refuseAdoption("adoption.request_binding_absent", only);
  }
  if (only.createRequestId !== intent.nonce) {
    return refuseAdoption("adoption.request_binding_mismatch", only);
  }

  const createdAt = Date.parse(only.createdAt ?? "");
  const notBefore = Date.parse(intent.notBefore);
  const notAfter = Date.parse(intent.notAfter);
  if (
    !Number.isFinite(createdAt) ||
    createdAt < notBefore ||
    createdAt > notAfter
  ) {
    return refuseAdoption("adoption.creation_time_outside_window", only);
  }

  if (!isEmptyConfiguration(only.configuration)) {
    let observedFingerprint: ConfigurationFingerprint | null = null;
    try {
      observedFingerprint = await computeConfigurationFingerprint(
        only.configuration,
      );
    } catch (error) {
      if (!(error instanceof InvalidConfigurationError)) {
        throw error;
      }
    }
    if (!fingerprintsMatch(observedFingerprint, intent.desiredFingerprint)) {
      return refuseAdoption("adoption.configuration_mismatch", only);
    }
  }

  return Object.freeze({
    adopted: true,
    code: "adoption.conclusively_bound",
    candidate: only,
  });
}

export type ResourceTarget = Readonly<{
  provider: string;
  resourceKind: string;
  resourceName: string;
}>;

export type ResourceOperations = Readonly<{
  findByProviderResourceId(
    providerResourceId: string,
  ): Promise<ProviderResourceCandidate | null>;
  findByName(
    resourceName: string,
  ): Promise<ReadonlyArray<ProviderResourceCandidate>>;
  create(input: {
    resourceName: string;
    configuration: unknown;
    /** Present only when the provider honours one. */
    idempotencyKey?: string;
  }): Promise<ProviderResourceCandidate>;
  patch(input: {
    candidate: ProviderResourceCandidate;
    drift: ReadonlyArray<string>;
    configuration: unknown;
  }): Promise<ProviderResourceCandidate>;
  readBack(
    candidate: ProviderResourceCandidate,
  ): Promise<ProviderResourceCandidate>;
  healthCheck(candidate: ProviderResourceCandidate): Promise<{
    passed: boolean;
    checkIds: ReadonlyArray<string>;
  }>;
  writeInstallationMarker(
    candidate: ProviderResourceCandidate,
  ): Promise<ProviderResourceCandidate>;
}>;

export type CreateIntentProtocol = Readonly<{
  log: ResourceCreateIntentLog;
  /** Set when the provider accepts an idempotency key on create. */
  supportsIdempotencyKey?: boolean;
  generateNonce: () => string;
  operationWindowSeconds?: number;
}>;

export type ReconciliationResult = Readonly<{
  step: ProvisioningStep;
  resource: ProvisioningResource | null;
  classification: ResourceClassification | "adopted";
  observation: ResourceObservation;
}>;

function resourceRecordFor({
  identity,
  target,
  candidate,
  operationId,
  ownershipPrincipal,
  adopted,
  desiredFingerprint,
  observedFingerprint,
  observedAt,
}: {
  identity: InstallationIdentity;
  target: ResourceTarget;
  candidate: ProviderResourceCandidate;
  operationId: string;
  ownershipPrincipal: string;
  adopted: boolean;
  desiredFingerprint: ConfigurationFingerprint;
  observedFingerprint: ConfigurationFingerprint;
  observedAt: string;
}): ProvisioningResource {
  return observeResource(
    createProvisioningResource({
      installationId: identity.installationId,
      deploymentId: identity.deploymentId,
      provider: target.provider,
      resourceKind: target.resourceKind,
      providerResourceId: candidate.providerResourceId,
      displayName: candidate.displayName,
      ownershipPrincipal,
      createdByOperationId: operationId,
      adopted,
      desiredFingerprint,
    }),
    { observedFingerprint, observedAt },
  );
}

export async function reconcileResource({
  identity,
  step,
  target,
  desiredConfiguration,
  repairableFields,
  operations,
  operationId,
  accountScopeFingerprint,
  recordedProviderResourceId,
  recordedResource,
  ownershipPrincipal = "client-account",
  createIntentProtocol,
  now,
}: {
  identity: InstallationIdentity;
  step: ProvisioningStep;
  target: ResourceTarget;
  desiredConfiguration: unknown;
  repairableFields: ReadonlyArray<string>;
  operations: ResourceOperations;
  operationId: string;
  accountScopeFingerprint: ConfigurationFingerprint;
  recordedProviderResourceId: string | null;
  /**
   * The journal's existing row for this resource, when one is recorded. It
   * carries the creation operation and adoption evidence that a later run must
   * preserve rather than overwrite with its own identity.
   */
  recordedResource?: ProvisioningResource;
  ownershipPrincipal?: string;
  /**
   * Required before any create. When the provider cannot honour an idempotency
   * key the intent is committed to the client repository first, so an ambiguous
   * response can later be resolved against durable evidence instead of name and
   * timing correlation.
   */
  createIntentProtocol?: CreateIntentProtocol;
  now: () => string;
}): Promise<ReconciliationResult> {
  const desiredFingerprint = await computeConfigurationFingerprint(
    desiredConfiguration,
  );

  // 1. Inspect: query by recorded provider ID first, and by the deterministic
  //    name only when that ID resolves to nothing. A recorded ID that no longer
  //    exists must never short-circuit to `absent`, because the name it used may
  //    still be taken — creating under it would be the duplicate this protocol
  //    exists to prevent.
  const byRecordedId =
    recordedProviderResourceId === null
      ? null
      : await operations.findByProviderResourceId(recordedProviderResourceId);
  const candidates =
    byRecordedId === null
      ? await operations.findByName(target.resourceName)
      : [byRecordedId];

  // 2. Classify the observation against the intended configuration.
  const observation = await classifyResourceObservation({
    identity,
    desiredConfiguration,
    desiredFingerprint,
    candidates,
    repairableFields,
  });

  // 3. An already-verified step observed as exact returns its existing receipt.
  //    Nothing is written and no health check is repeated, because the step has
  //    already proved this resource against this exact configuration. The
  //    journal's own row is carried forward rather than rebuilt, so the
  //    operation that created the resource — and whether it was adopted — is
  //    never re-attributed to the run that merely observed it.
  if (observation.classification === "exact" && step.status === "verified") {
    return Object.freeze({
      step,
      resource:
        recordedResource === undefined
          ? null
          : observeResource(recordedResource, {
              observedFingerprint: observation.observedFingerprint as string,
              observedAt: step.updatedAt,
            }),
      classification: "exact",
      observation,
    });
  }

  let adopted = false;
  let target_ = observation.candidate;

  // 4. An ambiguous observation may only be adopted through the create-intent
  //    committed to the client repository before the create, never by name or
  //    timing correlation.
  if (
    observation.classification === "ambiguous" &&
    createIntentProtocol !== undefined
  ) {
    const committed = await createIntentProtocol.log.find(target);
    if (committed !== null) {
      const decision = await evaluateCreateIntentAdoption({
        intent: committed,
        candidates: observation.candidates,
        intentCommitted: true,
        accountScopeFingerprint,
        laterConflictingIntentExists:
          await createIntentProtocol.log.hasLaterConflictingIntent(committed),
      });
      if (decision.adopted && decision.candidate !== null) {
        adopted = true;
        target_ = decision.candidate;
      }
    }
  }

  if (
    !adopted &&
    (observation.classification === "ambiguous" ||
      observation.classification === "foreign" ||
      observation.classification === "incompatible_drift")
  ) {
    const blocked = transitionStep(step, {
      status:
        step.status === "applied_unverified"
          ? "manual_action_required"
          : "blocked",
      at: now(),
      code: `reconcile.${observation.classification}`,
    });
    throw new ReconciliationReviewRequiredError({
      code: `reconcile.${observation.classification}`,
      classification: observation.classification,
      step: blocked,
      observation,
    });
  }

  // 5. Commit the durable create intent before a create the provider cannot
  //    make idempotent. Absence has just been proved by the inspection above.
  let idempotencyKey: string | undefined;
  if (observation.classification === "absent") {
    if (createIntentProtocol === undefined) {
      throw new CreateIntentError("create_intent_log_required");
    }
    // An intent is committed before every create, idempotent provider or not.
    // A resumed run reuses the committed nonce rather than minting a new one,
    // so a create whose response was lost is retried under the same identity
    // instead of becoming a second create.
    // A committed intent may only be reused when it was committed for this same
    // account, installation and deployment. Reusing one across accounts would
    // create in the account authenticated now under an intent approved for
    // another, which is the binding the account scope exists to enforce.
    const existing = await createIntentProtocol.log.find(target);
    const reusable =
      existing !== null &&
      existing.desiredFingerprint === desiredFingerprint &&
      existing.accountScopeFingerprint === accountScopeFingerprint &&
      existing.installationId === identity.installationId &&
      existing.deploymentId === identity.deploymentId;
    const intent =
      reusable && existing !== null
        ? existing
        : await (async () => {
            const fresh = await createResourceCreateIntent({
              identity,
              provider: target.provider,
              resourceKind: target.resourceKind,
              resourceName: target.resourceName,
              operationId,
              accountScopeFingerprint,
              desiredFingerprint,
              notBefore: now(),
              operationWindowSeconds:
                createIntentProtocol.operationWindowSeconds ?? 900,
              nonce: createIntentProtocol.generateNonce(),
              // The inspection above queried both the recorded ID and the
              // deterministic name and found nothing, which is the absence
              // proof this intent records.
              preflightProvedAbsent: true,
            });
            await createIntentProtocol.log.commit(fresh);
            return fresh;
          })();

    if (createIntentProtocol.supportsIdempotencyKey === true) {
      idempotencyKey = intent.nonce;
    }
  }

  // 6. Apply. Only now does the step become an in-flight write.
  //
  // A step already at `applied_unverified` is resuming after an ambiguous
  // write. If the resource is exact there is nothing to write and it stays
  // there for verification; if a write is still needed, the documented
  // `applied_unverified -> failed_retryable -> applying` path records that the
  // earlier attempt was proved not to have landed.
  const writes =
    adopted ||
    observation.classification === "absent" ||
    observation.classification === "repairable_drift";

  let applying: ProvisioningStep;
  if (step.status === "applied_unverified") {
    applying = writes
      ? transitionStep(
          transitionStep(step, {
            status: "failed_retryable",
            at: now(),
            code: "reconcile.write_not_observed",
          }),
          { status: "applying", at: now() },
        )
      : step;
  } else {
    applying = transitionStep(step, { status: "applying", at: now() });
  }

  try {
    if (adopted && target_ !== null) {
      target_ = await operations.writeInstallationMarker(target_);
    } else if (observation.classification === "absent") {
      const created = await operations.create({
        resourceName: target.resourceName,
        configuration: desiredConfiguration,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      });
      // A provider create returns an unmarked resource. The marker is what makes
      // it this installation's, so it is written before the readback that has to
      // observe it — otherwise every first creation would fail its own proof.
      target_ = await operations.writeInstallationMarker(created);
    } else if (
      observation.classification === "repairable_drift" &&
      target_ !== null
    ) {
      target_ = await operations.patch({
        candidate: target_,
        drift: observation.drift,
        configuration: desiredConfiguration,
      });
    }
  } catch {
    const unverified = transitionStep(applying, {
      status: "applied_unverified",
      at: now(),
      code: "reconcile.write_response_ambiguous",
    });
    throw new ReconciliationReviewRequiredError({
      code: "reconcile.write_response_ambiguous",
      classification: observation.classification,
      step: unverified,
      observation,
    });
  }

  if (applying.status === "applying") {
    applying = transitionStep(applying, {
      status: "applied_unverified",
      at: now(),
    });
  }

  if (target_ === null) {
    throw new ReconciliationReviewRequiredError({
      code: "reconcile.write_response_ambiguous",
      classification: observation.classification,
      step: applying,
      observation,
    });
  }

  // 7. Verify: read the client's account back, then prove health. Neither the
  //    provider's own create response nor a local record is accepted as proof.
  const readBack = await operations.readBack(target_);
  const observedFingerprint = await computeConfigurationFingerprint(
    readBack.configuration,
  );
  const markerMatches =
    readBack.installationMarker?.toLowerCase() === identity.installationId &&
    readBack.deploymentMarker?.toLowerCase() === identity.deploymentId;

  if (
    !fingerprintsMatch(observedFingerprint, desiredFingerprint) ||
    !markerMatches
  ) {
    throw new ReconciliationReviewRequiredError({
      code: "reconcile.readback_mismatch",
      classification: observation.classification,
      step: applying,
      observation,
    });
  }

  const health = await operations.healthCheck(readBack);
  if (!health.passed || health.checkIds.length === 0) {
    throw new ReconciliationReviewRequiredError({
      code: "reconcile.health_check_failed",
      classification: observation.classification,
      step: applying,
      observation,
    });
  }

  const verifiedAt = now();

  return Object.freeze({
    step: transitionStep(applying, {
      status: "verified",
      at: verifiedAt,
      verifiedChecks: health.checkIds,
    }),
    resource: resourceRecordFor({
      identity,
      target,
      candidate: readBack,
      operationId,
      ownershipPrincipal,
      adopted,
      desiredFingerprint,
      observedFingerprint,
      observedAt: verifiedAt,
    }),
    classification: adopted ? ("adopted" as const) : observation.classification,
    observation,
  });
}
