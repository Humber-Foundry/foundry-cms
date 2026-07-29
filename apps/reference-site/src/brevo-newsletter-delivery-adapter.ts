import {
  sha256CanonicalJson,
  sha256Text,
  type NewsletterDeliveryAdapter,
  type NewsletterDeliveryCapabilities,
  type NewsletterTestOutcome,
  type NewsletterTestRequest,
} from "@foundry/application";

const defaultBaseUrl = "https://api.brevo.com/v3";
const fingerprintPattern = /^[a-f0-9]{64}$/u;

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

function expectedSenderId(
  request: NewsletterTestRequest,
  senderIds: Readonly<Record<string, number>>,
) {
  const id = senderIds[request.senderIdentityId];
  return Number.isSafeInteger(id) && (id ?? 0) > 0 ? id! : null;
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
  senderIds,
  fetcher = fetch,
  baseUrl = defaultBaseUrl,
}: {
  apiKey: string;
  configurationFingerprint: string;
  accountScopeFingerprint: string;
  installationProofKey: string;
  senderIds: Readonly<Record<string, number>>;
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
  const capabilities: NewsletterDeliveryCapabilities = Object.freeze({
    provider: "brevo",
    configurationFingerprint,
    apiTestDelivery: "supported",
    explicitRecipients: "supported",
    ambiguousOutcomeReconciliation: "supported",
    plainTextArtifact: "unsupported",
  });

  function foundrySendProof(
    request: NewsletterTestRequest,
    providerCampaignId: string,
  ) {
    return sha256CanonicalJson({
      version: "foundry.brevo-transactional-test-send-proof.v1",
      installationProofKey,
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
      foundrySendProof: request.foundrySendProof!,
      providerReceipt: [
        "brevo:transactional-test:v1",
        request.executionId,
        messageId,
        request.binding.campaignFingerprint,
        request.binding.providerConfigurationFingerprint,
        request.binding.recipientSetFingerprint,
        request.foundrySendProof,
      ].join(":"),
    };
  }

  const adapter: NewsletterDeliveryAdapter = {
    async capabilities() {
      return capabilities;
    },
    async health() {
      try {
        const [account, senders] = await Promise.all([
          fetcher(`${endpoint}/account`, {
            method: "GET",
            headers: headers(apiKey),
          }),
          fetcher(`${endpoint}/senders`, {
            method: "GET",
            headers: headers(apiKey),
          }),
        ]);
        if (!account.ok || !senders.ok) {
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
        const senderBody = await json(senders) as {
          senders?: ReadonlyArray<{ id?: unknown; active?: unknown }>;
        } | null;
        const configuredIds = new Set(Object.values(senderIds));
        const allVerified =
          configuredIds.size > 0 &&
          [...configuredIds].every((id) =>
            (senderBody?.senders ?? []).some(
              (sender) => sender.id === id && sender.active === true,
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
      if (expectedSenderId(request, senderIds) === null) {
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
      const senderId = expectedSenderId(request, senderIds);
      const correlationId = providerCorrelationId(request.executionId);
      const sendProof = request.foundrySendProof;
      if (senderId === null) {
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
            sender: { id: senderId },
            to: request.recipients.map((recipient) => ({
              email: recipient.address,
            })),
            subject: request.subject,
            htmlContent: request.renderedCampaign.html.bytes,
            tags: [request.executionId],
            headers: {
              idempotencyKey: request.executionId,
              "X-Mailin-custom":
                `foundry_execution:${request.executionId}` +
                `|foundry_proof:${sendProof}`,
            },
          }),
        });
        if (!sent.ok) {
          if (outcomeCouldBeAmbiguous(sent.status)) {
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
      const senderId = expectedSenderId(request, senderIds);
      if (senderId === null) {
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
        const [eventsResponse, sendersResponse] = await Promise.all([
          fetcher(
            `${endpoint}/smtp/statistics/events?` +
              `tags=${encodeURIComponent(JSON.stringify([
                request.executionId,
              ]))}&limit=5000&sort=desc`,
            {
              method: "GET",
              headers: headers(apiKey),
              signal: AbortSignal.timeout(30_000),
            },
          ),
          fetcher(`${endpoint}/senders`, {
            method: "GET",
            headers: headers(apiKey),
            signal: AbortSignal.timeout(30_000),
          }),
        ]);
        if (!eventsResponse.ok || !sendersResponse.ok) {
          const status = !eventsResponse.ok
            ? eventsResponse.status
            : sendersResponse.status;
          return {
            outcome: "ambiguous",
            providerCampaignId: correlationId,
            foundrySendProof: request.foundrySendProof,
            ...(status === 429 ? { code: "provider_rate_limited" } : {}),
          } as const;
        }
        const eventsBody = await json(eventsResponse) as {
          events?: ReadonlyArray<{
            email?: unknown;
            messageId?: unknown;
            from?: unknown;
            tag?: unknown;
          }>;
        } | null;
        const senderBody = await json(sendersResponse) as {
          senders?: ReadonlyArray<{
            id?: unknown;
            email?: unknown;
            active?: unknown;
          }>;
        } | null;
        const sender = (senderBody?.senders ?? []).find(
          (candidate) =>
            candidate.id === senderId && candidate.active === true,
        );
        const senderEmail = recipientAddress(sender?.email);
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
        const eventSenders = new Set(
          events.map((event) => recipientAddress(event.from)),
        );
        if (
          senderEmail === null ||
          eventRecipients.has(null) ||
          messageIds.has(null) ||
          eventSenders.has(null) ||
          eventRecipients.size !== expectedRecipients.size ||
          [...eventRecipients].some(
            (address) =>
              address === null || !expectedRecipients.has(address),
          ) ||
          messageIds.size !== 1 ||
          eventSenders.size !== 1 ||
          !eventSenders.has(senderEmail)
        ) {
          return {
            outcome: "rejected",
            code: "provider_campaign_fingerprint_mismatch",
          };
        }
        const messageId = [...messageIds][0]!;
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
        if (
          rows.length !== expectedRecipients.size ||
          listedRecipients.has(null) ||
          listedRecipients.size !== expectedRecipients.size ||
          [...listedRecipients].some(
            (address) =>
              address === null || !expectedRecipients.has(address),
          ) ||
          rows.some(
            (row) =>
              row.messageId !== messageId ||
              row.subject !== request.subject ||
              typeof row.uuid !== "string" ||
              row.uuid.length === 0,
          )
        ) {
          return {
            outcome: "rejected",
            code: "provider_campaign_fingerprint_mismatch",
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
        if (
          contents.some(
            (content) =>
              content === null ||
              !expectedRecipients.has(
                recipientAddress(content.email) ?? "",
              ) ||
              content.subject !== request.subject ||
              content.body !== request.renderedCampaign.html.bytes,
          )
        ) {
          return {
            outcome: "rejected",
            code: "provider_campaign_fingerprint_mismatch",
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
