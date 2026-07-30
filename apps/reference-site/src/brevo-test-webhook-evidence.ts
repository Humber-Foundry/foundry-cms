import { hmacSha256CanonicalJson } from "@foundry/application";
import type { SiteId } from "@foundry/site-definition";

export type BrevoTestWebhookEvidence = Readonly<{
  eventFingerprint: string;
  payloadFingerprint: string;
  siteId: SiteId;
  executionId: string;
  foundrySendProof: string;
  providerMessageId: string;
  recipientFingerprint: string;
  eventType: string;
  occurredAt: string;
  receivedAt: string;
}>;

export interface BrevoTestWebhookEvidenceReader {
  listVerified(input: {
    executionId: string;
    foundrySendProof: string;
  }): Promise<ReadonlyArray<BrevoTestWebhookEvidence>>;
}

export interface BrevoTestWebhookEvidenceStore
  extends BrevoTestWebhookEvidenceReader {
  recordVerified(
    evidence: BrevoTestWebhookEvidence,
  ): Promise<"recorded" | "duplicate" | "conflict">;
}

export function brevoTestRecipientFingerprint(
  installationProofKey: string,
  address: string,
) {
  return hmacSha256CanonicalJson(installationProofKey, {
    domain: "foundry.brevo-test-recipient-fingerprint",
    version: 2,
    address: address.trim().toLowerCase(),
  });
}
