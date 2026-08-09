import {
  hmacSha256CanonicalJson,
  sha256CanonicalJson,
  sha256Text,
  type NewsletterDeliveryAdapter,
  type NewsletterDeliveryCapabilities,
  type NewsletterTestOutcome,
  type NewsletterTestRequest,
} from "@humber-foundry/application";

import {
  brevoTestRecipientFingerprint,
  type BrevoTestWebhookEvidenceReader,
} from "./brevo-test-webhook-evidence";
import {
  brevoSenderConfigurationFingerprint,
  normalizedBrevoSender,
} from "./brevo-sender-fingerprint";

const defaultBaseUrl = "https://api.brevo.com/v3";
const fingerprintPattern = /^[a-f0-9]{64}$/u;

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type BrevoSenderIdentity = Readonly<{
  id: number;
  email: string;
  name: string;
}>;

function headers(apiKey: string) {
  return {
    accept: "application/json",
    "api-key": apiKey,
    "content-type": "application/json",
  };
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function outcomeCouldBeAmbiguous(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

function expectedSender(
  request: NewsletterTestRequest,
  senders: Readonly<Record<string, BrevoSenderIdentity>>,
) {
  return normalizedBrevoSender(senders[request.senderIdentityId]);
}

function providerCorrelationId(executionId: string) {
  return `brevo-transactional-${executionId}`;
}

function providerMessageId(value: unknown): string | null {
  return typeof value === "string" &&
      value.length > 0 &&
      value.length <= 512
    ? value
    : null;
}

function recipientAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.includes("@") ? normalized : null;
}

export function createBrevoNewsletterDeliveryAdapter({
  apiKey,
  configurationFingerprint,
  accountScopeFingerprint,
  installationProofKey,
  senders,
  webhookEvidence = {
    async listVerified() {
      return [];
    },
  },
  fetcher = fetch,
  baseUrl = defaultBaseUrl,
}: {
  apiKey: string;
  configurationFingerprint: string;
  accountScopeFingerprint: string;
  installationProofKey: string;
  senders: Readonly<Record<string, BrevoSenderIdentity>>;
  webhookEvidence?: BrevoTestWebhookEvidenceReader;
  fetcher?: Fetcher;
  baseUrl?: string;
}): NewsletterDeliveryAdapter {
  if (apiKey.trim() === "") throw new Error("brevo_api_key_missing");
  if (!fingerprintPattern.test(configurationFingerprint)) {
    throw new Error("brevo_configuration_fingerprint_invalid");
  }
  if (!fingerprintPattern.test(accountScopeFingerprint)) {
    throw new Error("brevo_account_scope_fingerprint_invalid");
  }
  if (installationProofKey.length < 32) {
    throw new Error("brevo_installation_proof_key_invalid");
  }
  const endpoint = baseUrl.replace(/\/+$/u, "");
  const capabilities = Promise.all(
    Object.entries(senders).map(async ([logicalId, sender]) => {
      return [
        logicalId,
        await brevoSenderConfigurationFingerprint(logicalId, sender),
      ] as const;
    }),
  ).then(
    (senderConfigurationFingerprints) =>
      Object.freeze({
        provider: "brevo",
        configurationFingerprint,
        senderConfigurationFingerprints: Object.freeze(
          Object.fromEntries(senderConfigurationFingerprints),
        ),
        apiTestDelivery: "supported",
        explicitRecipients: "supported",
        ambiguousOutcomeReconciliation: "supported",
        plainTextArtifact: "unsupported",
      }) satisfies NewsletterDeliveryCapabilities,
  );

  function foundrySendProof(
    request: NewsletterTestRequest,
    providerCampaignId: string,
  ) {
    return hmacSha256CanonicalJson(installationProofKey, {
      domain: "foundry.brevo-transactional-test-send-proof",
      version: 2,
      executionId: request.executionId,
      providerCampaignId,
      subject: request.subject,
      senderIdentityId: request.senderIdentityId,
      binding: request.binding,
    });
  }

  function accepted(
    request: NewsletterTestRequest,
    messageId: string,
  ): NewsletterTestOutcome {
    return {
      outcome: "accepted",
      providerCampaignId: providerCorrelationId(request.executionId),
      providerMessageId: messageId,
      foundrySendProof: request.foundrySendProof!,
      providerReceipt: Object.freeze({
        version: "foundry.newsletter-test-provider-receipt.v1" as const,
        provider: "brevo",
        messageId,
      }),
    };
  }

  const adapter: NewsletterDeliveryAdapter = {
    async capabilities() {
      return capabilities;
    },
    async health() {
      try {
        const [account, senderResponse] = await Promise.all([
          fetcher(`${endpoint}/account`, {
            method: "GET",
            headers: headers(apiKey),
          }),
          fetcher(`${endpoint}/senders`, {
            method: "GET",
            headers: headers(apiKey),
          }),
        ]);
        if (!account.ok || !senderResponse.ok) {
          return {
            state: "unavailable",
            credential: account.status === 401 ? "invalid" : "unknown",
            senderIdentity: "unknown",
          } as const;
        }
        const accountBody = await json(account) as {
          email?: unknown;
        } | null;
        const accountEmail =
          typeof accountBody?.email === "string"
            ? accountBody.email.trim().toLowerCase()
            : "";
        const observedAccountScopeFingerprint =
          accountEmail === ""
            ? null
            : await sha256Text(
                `foundry.brevo-account-scope.v1:${accountEmail}`,
              );
        if (observedAccountScopeFingerprint !== accountScopeFingerprint) {
          return {
            state: "degraded",
            credential: "invalid",
            senderIdentity: "unknown",
          } as const;
        }
        const senderBody = await json(senderResponse) as {
          senders?: ReadonlyArray<{
            id?: unknown;
            email?: unknown;
            name?: unknown;
            active?: unknown;
          }>;
        } | null;
        const configuredSenders =
          Object.values(senders).map(normalizedBrevoSender);
        const allVerified =
          configuredSenders.length > 0 &&
          configuredSenders.every(
            (expected) =>
              expected !== null &&
              (senderBody?.senders ?? []).some(
                (sender) =>
                  sender.id === expected.id &&
                  sender.active === true &&
                  recipientAddress(sender.email) === expected.email &&
                  sender.name === expected.name,
              ),
          );
        return {
          state: allVerified ? "healthy" : "degraded",
          credential: "verified",
          senderIdentity: allVerified ? "verified" : "invalid",
        } as const;
      } catch {
        return {
          state: "unavailable",
          credential: "unknown",
          senderIdentity: "unknown",
        } as const;
      }
    },
    async prepareTest(request) {
      if (expectedSender(request, senders) === null) {
        return { outcome: "rejected", code: "provider_sender_unmapped" };
      }
      const correlationId = providerCorrelationId(request.executionId);
      if (
        request.providerCampaignId !== null &&
        request.providerCampaignId !== correlationId
      ) {
        return {
          outcome: "rejected",
          code: "provider_campaign_fingerprint_mismatch",
        };
      }
      return {
        outcome: "prepared",
        providerCampaignId: correlationId,
        foundrySendProof: await foundrySendProof(request, correlationId),
      };
    },
    async sendTest(request) {
      const sender = expectedSender(request, senders);
      const correlationId = providerCorrelationId(request.executionId);
      const sendProof = request.foundrySendProof;
      if (sender === null) {
        return { outcome: "rejected", code: "provider_sender_unmapped" };
      }
      if (
        request.providerCampaignId !== correlationId ||
        sendProof === null ||
        sendProof !== await foundrySendProof(request, correlationId)
      ) {
        return {
          outcome: "rejected",
          code: "foundry_send_proof_invalid",
        };
      }
      try {
        const sent = await fetcher(`${endpoint}/smtp/email`, {
          method: "POST",
          headers: headers(apiKey),
          signal: AbortSignal.timeout(30_000),
          body: JSON.stringify({
            sender: {
              email: sender.email,
              name: sender.name,
            },
            to: request.recipients.map((recipient) => ({
              email: recipient.address,
            })),
            subject: request.subject,
            htmlContent: request.renderedCampaign.html.bytes,
            tags: [request.executionId],
            headers: {
              "Idempotency-Key": request.executionId,
              "X-Mailin-custom":
                `foundry_execution:${request.executionId}` +
                `|foundry_proof:${sendProof}`,
            },
          }),
        });
        if (sent.status !== 201) {
          if (sent.ok || outcomeCouldBeAmbiguous(sent.status)) {
            return {
              outcome: "ambiguous",
              providerCampaignId: correlationId,
              foundrySendProof: sendProof,
              ...(sent.status === 429
                ? { code: "provider_rate_limited" }
                : {}),
            } as const;
          }
          return {
            outcome: "rejected",
            code: "provider_test_rejected",
          } as const;
        }
        const body = await json(sent) as { messageId?: unknown } | null;
        const messageId = providerMessageId(body?.messageId);
        if (messageId === null) {
          return {
            outcome: "ambiguous",
            providerCampaignId: correlationId,
            foundrySendProof: sendProof,
          } as const;
        }
        return accepted(request, messageId);
      } catch {
        return {
          outcome: "ambiguous",
          providerCampaignId: correlationId,
          foundrySendProof: sendProof,
        };
      }
    },
    async reconcileTest({ request, providerCampaignId }) {
      const correlationId = providerCorrelationId(request.executionId);
      if (
        providerCampaignId !== null &&
        providerCampaignId !== correlationId
      ) {
        return {
          outcome: "rejected",
          code: "provider_campaign_fingerprint_mismatch",
        };
      }
      const sender = expectedSender(request, senders);
      if (sender === null) {
        return { outcome: "rejected", code: "provider_sender_unmapped" };
      }
      if (
        request.foundrySendProof === null ||
        request.foundrySendProof !==
          await foundrySendProof(request, correlationId)
      ) {
        return {
          outcome: "ambiguous",
          ...(providerCampaignId === null ? {} : { providerCampaignId }),
        };
      }
      try {
        const eventsResponse = await fetcher(
          `${endpoint}/smtp/statistics/events?` +
            `tags=${encodeURIComponent(JSON.stringify([
              request.executionId,
            ]))}&limit=5000&sort=desc`,
          {
            method: "GET",
            headers: headers(apiKey),
            signal: AbortSignal.timeout(30_000),
          },
        );
        if (!eventsResponse.ok) {
          return {
            outcome: "ambiguous",
            providerCampaignId: correlationId,
            foundrySendProof: request.foundrySendProof,
            ...(eventsResponse.status === 429
              ? { code: "provider_rate_limited" }
              : {}),
          } as const;
        }
        const eventsBody = await json(eventsResponse) as {
          events?: ReadonlyArray<{
            email?: unknown;
            event?: unknown;
            messageId?: unknown;
            from?: unknown;
            tag?: unknown;
          }>;
        } | null;
        const senderEmail = recipientAddress(sender.email);
        const events = (eventsBody?.events ?? []).filter(
          (event) => event.tag === request.executionId,
        );
        if (events.length === 0) {
          return {
            outcome: "ambiguous",
            providerCampaignId: correlationId,
            foundrySendProof: request.foundrySendProof,
          };
        }
        const expectedRecipients = new Set(
          request.recipients.map((recipient) =>
            recipient.address.trim().toLowerCase()
          ),
        );
        const eventRecipients = new Set(
          events.map((event) => recipientAddress(event.email)),
        );
        const messageIds = new Set(
          events.map((event) => providerMessageId(event.messageId)),
        );
        const observedMessageIds = new Set(
          [...messageIds].filter(
            (messageId): messageId is string => messageId !== null,
          ),
        );
        const eventSenders = new Set(
          events.map((event) => recipientAddress(event.from)),
        );
        const conflictingEvents =
          [...eventRecipients].some(
            (address) =>
              address !== null && !expectedRecipients.has(address),
          ) ||
          observedMessageIds.size > 1 ||
          [...eventSenders].some(
            (address) => address !== null && address !== senderEmail,
          );
        if (conflictingEvents) {
          return {
            outcome: "rejected",
            code: "provider_campaign_fingerprint_mismatch",
          };
        }
        if (
          senderEmail === null ||
          eventRecipients.has(null) ||
          eventSenders.has(null) ||
          eventRecipients.size !== expectedRecipients.size ||
          eventSenders.size !== 1
        ) {
          return {
            outcome: "ambiguous",
            providerCampaignId: correlationId,
            foundrySendProof: request.foundrySendProof,
          };
        }
        const terminalNonDeliveryEvents = new Set([
          "blocked",
          "error",
          "hardBounces",
          "invalid",
        ]);
        const deliveryEvidenceEvents = new Set([
          "clicks",
          "delivered",
          "loadedByProxy",
          "opened",
          "spam",
          "unique_opened",
          "unsubscribed",
        ]);
        const everyRecipientDefinitelyNotDelivered =
          [...expectedRecipients].every((address) =>
            events.some(
              (event) =>
                recipientAddress(event.email) === address &&
                typeof event.event === "string" &&
                terminalNonDeliveryEvents.has(event.event),
            )
          );
        const anyRecipientDelivered = events.some(
          (event) =>
            typeof event.event === "string" &&
            deliveryEvidenceEvents.has(event.event),
        );
        if (
          everyRecipientDefinitelyNotDelivered &&
          !anyRecipientDelivered
        ) {
          return {
            outcome: "rejected",
            code: "provider_test_definitively_not_delivered",
          };
        }
        if (
          messageIds.has(null) ||
          observedMessageIds.size !== 1
        ) {
          return {
            outcome: "ambiguous",
            providerCampaignId: correlationId,
            foundrySendProof: request.foundrySendProof,
          };
        }
        const messageId = [...observedMessageIds][0]!;
        const emailListResponse = await fetcher(
          `${endpoint}/smtp/emails?messageId=${encodeURIComponent(messageId!)}`,
          {
            method: "GET",
            headers: headers(apiKey),
            signal: AbortSignal.timeout(30_000),
          },
        );
        if (!emailListResponse.ok) {
          return {
            outcome: "ambiguous",
            providerCampaignId: correlationId,
            foundrySendProof: request.foundrySendProof,
            ...(emailListResponse.status === 429
              ? { code: "provider_rate_limited" }
              : {}),
          } as const;
        }
        const emailList = await json(emailListResponse) as {
          transactionalEmails?: ReadonlyArray<{
            email?: unknown;
            messageId?: unknown;
            subject?: unknown;
            uuid?: unknown;
          }>;
        } | null;
        const rows = emailList?.transactionalEmails ?? [];
        const listedRecipients = new Set(
          rows.map((row) => recipientAddress(row.email)),
        );
        const conflictingRows =
          [...listedRecipients].some(
            (address) =>
              address !== null && !expectedRecipients.has(address),
          ) ||
          rows.some(
            (row) =>
              (row.messageId !== undefined &&
                row.messageId !== null &&
                row.messageId !== messageId) ||
              (row.subject !== undefined &&
                row.subject !== null &&
                row.subject !== request.subject),
          );
        if (conflictingRows) {
          return {
            outcome: "rejected",
            code: "provider_campaign_fingerprint_mismatch",
          };
        }
        if (
          rows.length !== expectedRecipients.size ||
          listedRecipients.has(null) ||
          listedRecipients.size !== expectedRecipients.size ||
          rows.some(
            (row) =>
              row.messageId !== messageId ||
              row.subject !== request.subject ||
              typeof row.uuid !== "string" ||
              row.uuid.length === 0,
          )
        ) {
          return {
            outcome: "ambiguous",
            providerCampaignId: correlationId,
            foundrySendProof: request.foundrySendProof,
          };
        }
        const contentResponses = await Promise.all(
          rows.map((row) =>
            fetcher(
              `${endpoint}/smtp/emails/${encodeURIComponent(
                row.uuid as string,
              )}`,
              {
                method: "GET",
                headers: headers(apiKey),
                signal: AbortSignal.timeout(30_000),
              },
            )
          ),
        );
        if (contentResponses.some((response) => !response.ok)) {
          const rateLimited = contentResponses.some(
            (response) => response.status === 429,
          );
          return {
            outcome: "ambiguous",
            providerCampaignId: correlationId,
            foundrySendProof: request.foundrySendProof,
            ...(rateLimited ? { code: "provider_rate_limited" } : {}),
          };
        }
        const contents = await Promise.all(
          contentResponses.map((response) => json(response)),
        ) as ReadonlyArray<{
          email?: unknown;
          subject?: unknown;
          body?: unknown;
        } | null>;
        const contentRecipients = new Set(
          contents.map((content) =>
            recipientAddress(content?.email)
          ),
        );
        const conflictingContents =
          [...contentRecipients].some(
            (address) =>
              address !== null && !expectedRecipients.has(address),
          ) ||
          contents.some(
            (content) =>
              content !== null &&
              ((content.subject !== undefined &&
                content.subject !== null &&
                content.subject !== request.subject) ||
                (content.body !== undefined &&
                  content.body !== null &&
                  content.body !== request.renderedCampaign.html.bytes)),
          );
        if (conflictingContents) {
          return {
            outcome: "rejected",
            code: "provider_campaign_fingerprint_mismatch",
          };
        }
        if (
          contentRecipients.has(null) ||
          contentRecipients.size !== expectedRecipients.size ||
          contents.some(
            (content) =>
              content === null ||
              content.subject !== request.subject ||
              content.body !== request.renderedCampaign.html.bytes,
          )
        ) {
          return {
            outcome: "ambiguous",
            providerCampaignId: correlationId,
            foundrySendProof: request.foundrySendProof,
          };
        }
        const expectedWebhookRecipients = new Set(
          await Promise.all(
            request.recipients.map((recipient) =>
              brevoTestRecipientFingerprint(
                installationProofKey,
                recipient.address,
              )
            ),
          ),
        );
        const proofBearingEvidence = await webhookEvidence.listVerified({
          executionId: request.executionId,
          foundrySendProof: request.foundrySendProof,
        });
        const webhookRecipients = new Set(
          proofBearingEvidence.map((event) => event.recipientFingerprint),
        );
        const conflictingWebhookEvidence =
          proofBearingEvidence.some(
            (event) =>
              event.providerMessageId !== messageId ||
              !expectedWebhookRecipients.has(event.recipientFingerprint),
          );
        if (conflictingWebhookEvidence) {
          return {
            outcome: "rejected",
            code: "provider_campaign_fingerprint_mismatch",
          };
        }
        if (
          webhookRecipients.size !== expectedWebhookRecipients.size ||
          [...expectedWebhookRecipients].some(
            (fingerprint) => !webhookRecipients.has(fingerprint),
          )
        ) {
          return {
            outcome: "ambiguous",
            providerCampaignId: correlationId,
            foundrySendProof: request.foundrySendProof,
          };
        }
        return accepted(request, messageId!);
      } catch {
        return {
          outcome: "ambiguous",
          providerCampaignId: correlationId,
          foundrySendProof: request.foundrySendProof,
        };
      }
    },
  };
  return Object.freeze(adapter);
}
