import { sha256CanonicalJson } from "@foundry/application";
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
  return sha256CanonicalJson({
    version: "foundry.brevo-test-recipient-proof.v1",
    installationProofKey,
    address: address.trim().toLowerCase(),
  });
}
