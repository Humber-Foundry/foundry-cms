/**
 * Logical credential slots.
 *
 * A slot is the durable record that a credential exists, who owns it, what it
 * may do, how it is rotated and whether its functional health check passed. The
 * value itself never becomes state: it moves from a safe interactive or
 * platform authorization surface straight into provider secret storage and is
 * never written to the journal, a plan, a report, a receipt or stdout.
 */

import { fingerprintPattern } from "./configuration-fingerprint";
import { OperatorError, requireText } from "./operator-errors";

export const credentialSlotCatalog = Object.freeze([
  "github_publisher_private_key",
  "cloudflare_access_sync_token",
  "cloudflare_analytics_read_token",
  "turnstile_secret",
  "brevo_api_key",
  "brevo_webhook_verification_secret",
  "staff_notification_transport_secret",
  "mcp_oauth_signing_key",
  "csrf_signing_key",
  "backup_recovery_recipient",
  "provisioning_receipt_signing_key",
] as const);

export type CredentialSlotId = (typeof credentialSlotCatalog)[number];

/**
 * Surfaces through which a secret may reach provider storage. Each one either
 * keeps the value inside an operating-system browser session or reads it from a
 * non-echoing stream that no other process, file or log observes.
 */
export const safeIntakeSurfaces = Object.freeze([
  "browser_authorization",
  "hidden_stdin",
  "provider_creation_response",
  "generated_in_memory",
  "not_required",
] as const);

/**
 * Surfaces the provisioning invariants forbid. Naming them explicitly means a
 * refusal is a stated policy decision rather than an unhandled case.
 */
export const refusedIntakeSurfaces = Object.freeze([
  "command_argument",
  "environment_variable",
  "plan_file",
  "repository_file",
  "journal_row",
  "log_output",
  "url_parameter",
] as const);

export type CredentialIntakeSurface = (typeof safeIntakeSurfaces)[number];

export type RefusedIntakeSurface = (typeof refusedIntakeSurfaces)[number];

export type CredentialSlotHealth =
  | "missing"
  | "unverified"
  | "verified"
  | "not_required"
  | "revoked";

export type CredentialSlot = Readonly<{
  slotId: CredentialSlotId;
  provider: string;
  ownershipPrincipal: string;
  intakeSurface: CredentialIntakeSurface;
  minimumAuthority: string;
  rotationProcedure: string;
  healthCheckId: string;
  health: CredentialSlotHealth;
  rotatedAt: string | null;
  verifiedAt: string | null;
  bindingFingerprint?: string;
}>;

export class CredentialSlotError extends OperatorError {
  readonly slot: CredentialSlot | null;

  constructor(code: string, slot: CredentialSlot | null = null) {
    super(code);
    this.slot = slot;
  }
}

export class CredentialIntakeRefusedError extends CredentialSlotError {}

function requiredText(value: unknown, code: string): string {
  return requireText(value, code, (reason) => new CredentialSlotError(reason));
}

export function createCredentialSlot(input: {
  slotId: CredentialSlotId;
  provider: string;
  ownershipPrincipal: string;
  intakeSurface: CredentialIntakeSurface;
  minimumAuthority: string;
  rotationProcedure: string;
  healthCheckId: string;
  bindingFingerprint?: string;
}): CredentialSlot {
  const slotId = requiredText(input.slotId, "credential_slot_id_invalid");
  if (!(credentialSlotCatalog as ReadonlyArray<string>).includes(slotId)) {
    throw new CredentialSlotError("credential_slot_id_unknown");
  }

  const intakeSurface = requiredText(
    input.intakeSurface,
    "credential_intake_surface_invalid",
  );
  if ((refusedIntakeSurfaces as ReadonlyArray<string>).includes(intakeSurface)) {
    throw new CredentialIntakeRefusedError("credential_intake_surface_refused");
  }
  if (!(safeIntakeSurfaces as ReadonlyArray<string>).includes(intakeSurface)) {
    throw new CredentialIntakeRefusedError("credential_intake_surface_unknown");
  }

  const secretless = intakeSurface === "not_required";
  if (secretless && !fingerprintPattern.test(input.bindingFingerprint ?? "")) {
    throw new CredentialSlotError("credential_binding_fingerprint_required");
  }
  if (!secretless && input.bindingFingerprint !== undefined) {
    throw new CredentialSlotError("credential_binding_fingerprint_unexpected");
  }

  const slot = {
    slotId: slotId as CredentialSlotId,
    provider: requiredText(input.provider, "credential_provider_invalid"),
    ownershipPrincipal: requiredText(
      input.ownershipPrincipal,
      "credential_ownership_principal_required",
    ),
    intakeSurface: intakeSurface as CredentialIntakeSurface,
    minimumAuthority: requiredText(
      input.minimumAuthority,
      "credential_minimum_authority_required",
    ),
    rotationProcedure: requiredText(
      input.rotationProcedure,
      "credential_rotation_procedure_required",
    ),
    healthCheckId: requiredText(
      input.healthCheckId,
      "credential_health_check_required",
    ),
    health: (secretless ? "not_required" : "missing") as CredentialSlotHealth,
    rotatedAt: null,
    verifiedAt: null,
    ...(secretless
      ? { bindingFingerprint: input.bindingFingerprint as string }
      : {}),
  };

  return Object.freeze(slot);
}

function withHealth(
  slot: CredentialSlot,
  changes: Partial<
    Pick<CredentialSlot, "health" | "rotatedAt" | "verifiedAt">
  >,
): CredentialSlot {
  return Object.freeze({ ...slot, ...changes });
}

export type CredentialUploadReceipt = Readonly<{
  slot: CredentialSlot;
  providerReference: string;
}>;

/**
 * Reads a secret from its declared safe surface and hands it directly to the
 * uploader. The value is referenced exactly once, never returned, and the
 * receipt records only the slot's new health and an opaque provider reference.
 */
export async function acceptCredentialThroughSlot({
  slot,
  readSecret,
  upload,
  observedAt,
}: {
  slot: CredentialSlot;
  readSecret: () => Promise<string>;
  upload: (secret: string) => Promise<{ providerReference: string }>;
  observedAt: string;
}): Promise<CredentialUploadReceipt> {
  if (slot.intakeSurface === "not_required") {
    throw new CredentialIntakeRefusedError(
      "credential_intake_not_required",
      slot,
    );
  }
  if (slot.health === "revoked") {
    throw new CredentialSlotError("credential_slot_revoked", slot);
  }

  const secret = await readSecret();
  if (typeof secret !== "string" || secret.length === 0) {
    throw new CredentialSlotError("credential_intake_empty", slot);
  }

  // From here the slot can never return to `missing`: an interrupted upload may
  // still have reached the provider, so the next action must rotate or re-enter
  // rather than assume nothing happened.
  const pending = withHealth(slot, { health: "unverified", verifiedAt: null });

  let providerReference: string;
  try {
    ({ providerReference } = await upload(secret));
  } catch {
    throw new CredentialSlotError("credential_upload_unverified", pending);
  }

  if (typeof providerReference !== "string" || providerReference.length === 0) {
    throw new CredentialSlotError("credential_upload_unverified", pending);
  }

  return Object.freeze({
    slot: withHealth(pending, { rotatedAt: pending.rotatedAt ?? observedAt }),
    providerReference,
  });
}

export function markCredentialSlotVerified(
  slot: CredentialSlot,
  { healthCheckId, observedAt }: { healthCheckId: string; observedAt: string },
): CredentialSlot {
  if (healthCheckId !== slot.healthCheckId) {
    throw new CredentialSlotError("credential_health_check_mismatch", slot);
  }
  if (slot.health === "revoked") {
    throw new CredentialSlotError("credential_slot_revoked", slot);
  }
  return withHealth(slot, { health: "verified", verifiedAt: observedAt });
}

export function recordCredentialRotation(
  slot: CredentialSlot,
  { rotatedAt }: { rotatedAt: string },
): CredentialSlot {
  if (slot.intakeSurface === "not_required") {
    throw new CredentialSlotError("credential_rotation_not_applicable", slot);
  }
  return withHealth(slot, {
    health: "unverified",
    rotatedAt,
    verifiedAt: null,
  });
}

export function markCredentialSlotRevoked(
  slot: CredentialSlot,
  { observedAt }: { observedAt: string },
): CredentialSlot {
  return withHealth(slot, { health: "revoked", verifiedAt: observedAt });
}

/**
 * Deploy fails when an adapter declares a secret with no slot row, and when a
 * slot row exists that no declared adapter accounts for. Omitting a slot is
 * never allowed to mean "probably configured".
 */
export function assertDeclaredCredentialSlotsSatisfied({
  declaredSlotIds,
  slots,
}: {
  declaredSlotIds: ReadonlyArray<string>;
  slots: ReadonlyArray<CredentialSlot>;
}): void {
  const recorded = new Set<string>();
  for (const slot of slots) {
    if (recorded.has(slot.slotId)) {
      throw new CredentialSlotError("credential_slot_duplicated", slot);
    }
    recorded.add(slot.slotId);
  }

  const declared = new Set(declaredSlotIds);
  for (const slotId of declared) {
    if (!recorded.has(slotId)) {
      throw new CredentialSlotError("credential_slot_row_missing");
    }
  }
  for (const slot of slots) {
    if (!declared.has(slot.slotId)) {
      throw new CredentialSlotError("credential_slot_undeclared", slot);
    }
  }
}
