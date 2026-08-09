import {
  type CampaignBulkDeliveryAdapter,
  type CampaignBulkProviderOutcome,
  type CampaignBulkProviderReconciliation,
  type CampaignBulkProviderRequest,
} from "@humber-foundry/application";

import {
  brevoBulkCorrelationId,
  brevoProviderOccurredAt,
  normalizedBrevoEventType,
} from "./brevo-campaign-event-normalization";
import {
  brevoCampaignSenderFingerprint,
  normalizedBrevoSender,
  type BrevoSenderConfiguration as BrevoSenderIdentity,
} from "./brevo-sender-fingerprint";

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function headers(apiKey: string) {
  return {
    accept: "application/json",
    "api-key": apiKey,
    "content-type": "application/json",
  };
}

type ReportedEvent = Readonly<{
  email?: unknown;
  event?: unknown;
  messageId?: unknown;
  from?: unknown;
  tag?: unknown;
  date?: unknown;
}>;

/**
 * Brevo's event report is paged. A 1000-recipient send produces a few thousand
 * events, so the budget covers a complete report for the largest audience one
 * operation may have without letting a runaway report exhaust the runtime's
 * subrequest allowance.
 */
const reportPageSize = 1000;
const reportPageLimit = 20;

/**
 * How long after a provider attempt an empty tagged report is accepted as proof
 * that no send exists. Brevo records a `request` event on acceptance, so this
 * only has to outlast reporting lag.
 */
const reportLagAllowanceMs = 15 * 60_000;

function normalizedAddress(value: unknown) {
  if (typeof value !== "string") return null;
  const address = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(address) ? address : null;
}

async function responseJson(response: Response) {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

function messageId(value: unknown) {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    ? value
    : null;
}

/**
 * Brevo accepts at most 1000 `messageVersions` in one transactional request.
 * Foundry sends exactly one version per recipient so no subscriber address is
 * disclosed to another recipient, so the version limit is also the audience
 * limit for one logical send operation.
 */
export const brevoBulkRecipientLimit = 1000;

function acceptedMessageIds(body: unknown, expectedVersions: number) {
  if (typeof body !== "object" || body === null) return null;
  const ids = "messageIds" in body ? body.messageIds : null;
  if (!Array.isArray(ids) || ids.length !== expectedVersions) return null;
  const normalized = ids.map(messageId);
  return normalized.some((id) => id === null) ||
    new Set(normalized).size !== normalized.length
    ? null
    : (normalized as ReadonlyArray<string>);
}

export function createBrevoCampaignBulkDeliveryAdapter({
  apiKey,
  providerConfigurationFingerprint,
  senders,
  fetcher = fetch,
  baseUrl = "https://api.brevo.com/v3",
  now = () => new Date(),
}: {
  apiKey: string;
  providerConfigurationFingerprint: string;
  senders: Readonly<Record<string, BrevoSenderIdentity>>;
  fetcher?: Fetcher;
  baseUrl?: string;
  now?: () => Date;
}): CampaignBulkDeliveryAdapter {
  if (apiKey.trim() === "") throw new Error("brevo_api_key_missing");
  if (!/^[a-f0-9]{64}$/u.test(providerConfigurationFingerprint)) {
    throw new Error("brevo_configuration_fingerprint_invalid");
  }
  const endpoint = baseUrl.replace(/\/+$/u, "");

  async function senderMatchesArtifact(
    request: CampaignBulkProviderRequest,
    configuredSender: BrevoSenderIdentity | null,
  ) {
    if (configuredSender === null) return false;
    const logicalId = request.sendArtifact.senderIdentityId;
    return (
      request.sendArtifact.sender.email.trim().toLowerCase() ===
        configuredSender.email &&
      request.sendArtifact.sender.name.trim() === configuredSender.name &&
      request.sendArtifact.senderFingerprint ===
        (await brevoCampaignSenderFingerprint(logicalId, senders[logicalId])) &&
      request.sendArtifact.providerConfigurationFingerprint ===
        providerConfigurationFingerprint
    );
  }

  const adapter: CampaignBulkDeliveryAdapter = Object.freeze({
    providerCampaignIdFor: brevoBulkCorrelationId,
    async sendBulk(
      request: CampaignBulkProviderRequest,
    ): Promise<CampaignBulkProviderOutcome> {
      const expectedCorrelation = brevoBulkCorrelationId(request.operationId);
      if (
        request.providerCampaignId !== null &&
        request.providerCampaignId !== expectedCorrelation
      ) {
        return {
          outcome: "rejected",
          code: "provider_campaign_fingerprint_mismatch",
        };
      }
      const configuredSender = normalizedBrevoSender(
        senders[request.sendArtifact.senderIdentityId],
      );
      if (configuredSender === null) {
        return { outcome: "rejected", code: "provider_sender_unmapped" };
      }
      if (!(await senderMatchesArtifact(request, configuredSender))) {
        return {
          outcome: "rejected",
          code: "provider_campaign_fingerprint_mismatch",
        };
      }
      if (
        request.recipients.length === 0 ||
        request.recipients.length > brevoBulkRecipientLimit
      ) {
        return { outcome: "rejected", code: "provider_audience_unsupported" };
      }
      try {
        const response = await fetcher(`${endpoint}/smtp/email`, {
          method: "POST",
          headers: headers(apiKey),
          signal: AbortSignal.timeout(30_000),
          body: JSON.stringify({
            sender: configuredSender,
            // One version per recipient. Brevo rejects an outer `to` alongside
            // `messageVersions`, and a shared `to` would expose every
            // subscriber address in the delivered header of every message.
            messageVersions: request.recipients.map(({ address }) => ({
              to: [{ email: address }],
            })),
            subject: request.sendArtifact.subject,
            htmlContent: request.sendArtifact.htmlContent,
            textContent: request.sendArtifact.textContent,
            tags: [request.operationId],
            headers: {
              "Idempotency-Key": request.operationId,
              "X-Mailin-custom":
                `foundry_bulk_operation:${request.operationId}` +
                `|foundry_bulk_proof:${request.providerSendProof}`,
            },
          }),
        });
        if (response.status !== 201) {
          if (
            response.ok ||
            response.status === 409 ||
            response.status === 408 ||
            response.status === 429 ||
            response.status >= 500
          ) {
            return {
              outcome: "ambiguous",
              providerCampaignId: expectedCorrelation,
              code:
                response.status === 429
                  ? "provider_rate_limited"
                  : "provider_result_ambiguous",
            };
          }
          return {
            outcome: "rejected",
            code: "provider_bulk_send_rejected",
          };
        }
        const providerMessageIds = acceptedMessageIds(
          await responseJson(response),
          request.recipients.length,
        );
        if (providerMessageIds === null) {
          return {
            outcome: "ambiguous",
            providerCampaignId: expectedCorrelation,
            code: "provider_result_ambiguous",
          };
        }
        return {
          outcome: "accepted",
          providerCampaignId: expectedCorrelation,
          // A per-version batch yields one identifier per recipient. Only a
          // single-recipient send has an unambiguous operation-wide message
          // identity; the verified set arrives through reconciliation.
          providerMessageId:
            providerMessageIds.length === 1 ? providerMessageIds[0]! : null,
        };
      } catch {
        return {
          outcome: "ambiguous",
          providerCampaignId: expectedCorrelation,
          code: "provider_result_ambiguous",
        };
      }
    },
    async reconcileBulk(
      request: CampaignBulkProviderRequest,
    ): Promise<CampaignBulkProviderReconciliation> {
      const expectedCorrelation = brevoBulkCorrelationId(request.operationId);
      if (
        request.providerCampaignId !== null &&
        request.providerCampaignId !== expectedCorrelation
      ) {
        return {
          outcome: "rejected",
          code: "provider_campaign_fingerprint_mismatch",
        };
      }
      const persistedSender = {
        email: normalizedAddress(request.sendArtifact.sender.email),
        name: request.sendArtifact.sender.name.trim(),
      };
      if (persistedSender.email === null || persistedSender.name === "") {
        return {
          outcome: "rejected",
          code: "provider_campaign_fingerprint_mismatch",
        };
      }
      try {
        // The report is paged, and one recipient produces several events, so a
        // large audience needs more than one page. Exact recipient-set
        // agreement is only meaningful over the whole report.
        const events: ReportedEvent[] = [];
        for (let page = 0; page < reportPageLimit; page += 1) {
          const response = await fetcher(
            `${endpoint}/smtp/statistics/events?` +
              `tags=${encodeURIComponent(
                JSON.stringify([request.operationId]),
              )}&limit=${reportPageSize}` +
              `&offset=${page * reportPageSize}&sort=desc`,
            {
              method: "GET",
              headers: headers(apiKey),
              signal: AbortSignal.timeout(30_000),
            },
          );
          if (!response.ok) {
            return {
              outcome: "ambiguous",
              providerCampaignId: expectedCorrelation,
              code:
                response.status === 429
                  ? "provider_rate_limited"
                  : "provider_result_ambiguous",
            };
          }
          const body = (await responseJson(response)) as {
            events?: ReadonlyArray<ReportedEvent>;
          } | null;
          const reported = body?.events ?? [];
          events.push(
            ...reported.filter(({ tag }) => tag === request.operationId),
          );
          if (reported.length < reportPageSize) break;
          if (page + 1 === reportPageLimit) {
            // The report did not end within the page budget, so this pass saw
            // an incomplete picture and must not conclude anything.
            return {
              outcome: "ambiguous",
              providerCampaignId: expectedCorrelation,
              code: "provider_report_incomplete",
            };
          }
        }
        if (events.length === 0) {
          // A readable report with no event at all for this operation's tag is
          // the only evidence Brevo offers that a send does not exist. Brevo
          // records a `request` event on acceptance, so once the report lag
          // allowance has passed an empty report proves absence and makes a
          // replacement send safe. Before that it is merely uncertain.
          return Date.parse(request.attemptedAt) + reportLagAllowanceMs <=
            now().getTime()
            ? { outcome: "not_sent" }
            : {
                outcome: "ambiguous",
                providerCampaignId: expectedCorrelation,
                code: "provider_result_ambiguous",
              };
        }
        const expectedRecipients = new Set(
          request.recipients.map(({ address }) => address.trim().toLowerCase()),
        );
        const observedRecipients = new Set(
          events.map(({ email }) => normalizedAddress(email)),
        );
        const observedSenders = new Set(
          events.map(({ from }) => normalizedAddress(from)),
        );
        const observedMessageIds = new Set(
          events.map(({ messageId: value }) => messageId(value)),
        );
        if (
          observedRecipients.has(null) ||
          observedRecipients.size !== expectedRecipients.size ||
          [...expectedRecipients].some(
            (address) => !observedRecipients.has(address),
          ) ||
          [...observedRecipients].some(
            (address) => address !== null && !expectedRecipients.has(address),
          ) ||
          observedSenders.has(null) ||
          [...observedSenders].some(
            (address) => address !== persistedSender.email,
          ) ||
          observedMessageIds.has(null) ||
          // One message version per recipient means one identifier per
          // recipient; anything else is an incomplete or foreign report.
          observedMessageIds.size !== expectedRecipients.size
        ) {
          return {
            outcome: "ambiguous",
            providerCampaignId: expectedCorrelation,
            code: "provider_result_ambiguous",
          };
        }
        const providerMessageIds = [...observedMessageIds]
          .filter((value): value is string => value !== null)
          .sort();
        // Reconciliation answers whether this exact operation reached the
        // provider, not whether its content is correct: the authorization
        // fingerprint already binds the content, and the test delivery for that
        // same fingerprint already proved the rendered bytes at the provider.
        // The tag-filtered event report is therefore one request regardless of
        // audience size, so a large send cannot exhaust the runtime's
        // subrequest budget mid-reconciliation and strand itself.
        const identityByAddress = new Map(
          request.recipients.map((recipient) => [
            recipient.address.trim().toLowerCase(),
            recipient.identityKey,
          ]),
        );
        const facts = events.flatMap((event) => {
          const address = normalizedAddress(event.email);
          const identityKey =
            address === null ? undefined : identityByAddress.get(address);
          const type = normalizedBrevoEventType(event.event);
          const occurredAt = brevoProviderOccurredAt(event.date);
          if (
            identityKey === undefined ||
            type === null ||
            occurredAt === null
          ) {
            return [];
          }
          return [
            {
              providerMessageId: messageId(event.messageId),
              recipientIdentityKey: identityKey,
              type,
              occurredAt,
            },
          ];
        });
        return {
          outcome: "verified",
          providerCampaignId: expectedCorrelation,
          providerMessageIds,
          facts,
        };
      } catch {
        return {
          outcome: "ambiguous",
          providerCampaignId: expectedCorrelation,
          code: "provider_result_ambiguous",
        };
      }
    },
  });
  return adapter;
}
