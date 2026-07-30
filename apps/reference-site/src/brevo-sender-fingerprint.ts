import { sha256CanonicalJson } from "@foundry/application";

/**
 * The one definition of a Brevo sender's identity digests.
 *
 * `foundry.brevo-sender-configuration.v1` and `foundry.campaign-test-sender.v2`
 * are the drift gate for both test and bulk delivery: an artifact is only
 * dispatched when its recorded sender fingerprint still equals the one derived
 * from live configuration. A second definition of either formula would let one
 * surface accept a sender the other rejects while both claim the same version,
 * so every surface reads these functions rather than restating the shape.
 */

export type BrevoSenderConfiguration = Readonly<{
  id: number;
  email: string;
  name: string;
}>;

/**
 * The sender exactly as Brevo will be asked to use it, or null when the
 * configured value cannot be a usable verified sender.
 */
export function normalizedBrevoSender(
  sender: unknown,
): BrevoSenderConfiguration | null {
  if (typeof sender !== "object" || sender === null) return null;
  const candidate = sender as {
    id?: unknown;
    email?: unknown;
    name?: unknown;
  };
  const email =
    typeof candidate.email === "string" &&
    candidate.email.trim().toLowerCase().includes("@")
      ? candidate.email.trim().toLowerCase()
      : null;
  const name =
    typeof candidate.name === "string" ? candidate.name.trim() : undefined;
  if (
    typeof candidate.id !== "number" ||
    !Number.isSafeInteger(candidate.id) ||
    candidate.id <= 0 ||
    email === null ||
    name === undefined ||
    name.length === 0 ||
    name.length > 200
  ) {
    return null;
  }
  return Object.freeze({ id: candidate.id, email, name });
}

/** The digest of one logical sender's declared Brevo configuration. */
export function brevoSenderConfigurationFingerprint(
  logicalId: string,
  sender: unknown,
) {
  const normalized = normalizedBrevoSender(sender);
  return sha256CanonicalJson({
    version: "foundry.brevo-sender-configuration.v1",
    logicalId,
    id: normalized?.id ?? null,
    email: normalized?.email ?? null,
    name: normalized?.name ?? null,
  });
}

/** The sender fingerprint a campaign artifact records and is checked for. */
export async function brevoCampaignSenderFingerprint(
  logicalId: string,
  sender: unknown,
) {
  return sha256CanonicalJson({
    version: "foundry.campaign-test-sender.v2",
    senderIdentityId: logicalId,
    senderConfigurationFingerprint: await brevoSenderConfigurationFingerprint(
      logicalId,
      sender,
    ),
  });
}
