import type { SiteId } from "@humber-foundry/site-definition";

import type { D1DatabaseBinding } from "./d1-human-access-store";
import type {
  BrevoTestWebhookEvidence,
  BrevoTestWebhookEvidenceStore,
} from "./brevo-test-webhook-evidence";

type EvidenceRow = Readonly<{
  event_fingerprint: string;
  payload_fingerprint: string;
  site_id: string;
  execution_id: string;
  foundry_send_proof: string;
  provider_message_id: string;
  recipient_fingerprint: string;
  event_type: string;
  occurred_at: string;
  received_at: string;
}>;

function evidence(row: EvidenceRow): BrevoTestWebhookEvidence {
  return Object.freeze({
    eventFingerprint: row.event_fingerprint,
    payloadFingerprint: row.payload_fingerprint,
    siteId: row.site_id as SiteId,
    executionId: row.execution_id,
    foundrySendProof: row.foundry_send_proof,
    providerMessageId: row.provider_message_id,
    recipientFingerprint: row.recipient_fingerprint,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
  });
}

export function createD1BrevoTestWebhookEvidenceStore({
  database,
  siteId,
}: {
  database: D1DatabaseBinding;
  siteId: SiteId;
}): BrevoTestWebhookEvidenceStore {
  const store: BrevoTestWebhookEvidenceStore = {
    async recordVerified(input) {
      if (input.siteId !== siteId) return "conflict";
      const result = await database
        .prepare(
          `INSERT INTO campaign_test_brevo_webhook_evidence (
             event_fingerprint, site_id, execution_id, foundry_send_proof,
             payload_fingerprint, provider_message_id, recipient_fingerprint,
             event_type, occurred_at, received_at
           )
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
           WHERE EXISTS (
             SELECT 1 FROM campaign_test_deliveries
             WHERE execution_id = ?3 AND site_id = ?2
               AND foundry_send_proof = ?4
               AND state IN ('attempting', 'ambiguous', 'accepted')
           )
           ON CONFLICT (event_fingerprint) DO NOTHING`,
        )
        .bind(
          input.eventFingerprint,
          input.siteId,
          input.executionId,
          input.foundrySendProof,
          input.payloadFingerprint,
          input.providerMessageId,
          input.recipientFingerprint,
          input.eventType,
          input.occurredAt,
          input.receivedAt,
        )
        .run();
      if ((result.meta.changes ?? 0) === 1) return "recorded";
      const existing = await database
        .prepare(
          `SELECT payload_fingerprint
           FROM campaign_test_brevo_webhook_evidence
           WHERE event_fingerprint = ?1 AND site_id = ?2`,
        )
        .bind(input.eventFingerprint, siteId)
        .first<{ payload_fingerprint: string }>();
      if (existing === null) return "conflict";
      return existing.payload_fingerprint === input.payloadFingerprint
        ? "duplicate"
        : "conflict";
    },
    async listVerified({ executionId, foundrySendProof }) {
      const result = await database
        .prepare(
          `SELECT event_fingerprint, payload_fingerprint, site_id, execution_id,
             foundry_send_proof, provider_message_id, recipient_fingerprint,
             event_type, occurred_at, received_at
           FROM campaign_test_brevo_webhook_evidence
           WHERE site_id = ?1 AND execution_id = ?2
             AND foundry_send_proof = ?3
           ORDER BY occurred_at, event_fingerprint`,
        )
        .bind(siteId, executionId, foundrySendProof)
        .all<EvidenceRow>();
      return Object.freeze(result.results.map(evidence));
    },
  };
  return Object.freeze(store);
}
