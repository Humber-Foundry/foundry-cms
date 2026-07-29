import {
  sha256CanonicalJson,
  sha256Text,
  type NewsletterDeliveryAdapter,
  type NewsletterDeliveryCapabilities,
  type NewsletterTestAmbiguityCode,
  type NewsletterTestOutcome,
  type NewsletterTestRequest,
} from "@foundry/application";

const defaultBaseUrl = "https://api.brevo.com/v3";
const fingerprintPattern = /^[a-f0-9]{64}$/u;

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type BrevoCampaign = Readonly<{
  id?: unknown;
  name?: unknown;
  tag?: unknown;
  sender?: Readonly<{ id?: unknown }>;
  subject?: unknown;
  previewText?: unknown;
  htmlContent?: unknown;
  testSent?: unknown;
}>;

type CampaignRead =
  | Readonly<{ outcome: "found"; campaign: BrevoCampaign }>
  | Readonly<{ outcome: "not_found" }>
  | Readonly<{
      outcome: "ambiguous";
      code?: NewsletterTestAmbiguityCode;
    }>;

function campaignName(executionId: string) {
  return `foundry-test-${executionId}`;
}

function campaignTag(executionId: string) {
  return `f-test-${executionId.replaceAll("-", "").slice(-16)}`;
}

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

function providerId(value: unknown): string | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : typeof value === "string" && /^[1-9][0-9]*$/u.test(value)
      ? value
      : null;
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

function matchesCampaign(
  campaign: BrevoCampaign,
  request: NewsletterTestRequest,
  senderId: number,
) {
  return (
    campaign.name === campaignName(request.executionId) &&
    campaign.tag === campaignTag(request.executionId) &&
    campaign.sender?.id === senderId &&
    campaign.subject === request.subject &&
    campaign.previewText === request.previewText &&
    campaign.htmlContent === request.renderedCampaign.html.bytes
  );
}

function accepted(
  request: NewsletterTestRequest,
  campaign: BrevoCampaign,
  foundrySendProof: string,
): NewsletterTestOutcome {
  const id = providerId(campaign.id);
  if (id === null) return { outcome: "ambiguous" };
  return {
    outcome: "accepted",
    providerCampaignId: id,
    foundrySendProof,
    providerReceipt: [
      "brevo:test:v1",
      request.executionId,
      id,
      request.binding.campaignFingerprint,
      request.binding.providerConfigurationFingerprint,
      request.binding.recipientSetFingerprint,
      foundrySendProof,
    ].join(":"),
  };
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
      version: "foundry.brevo-test-send-proof.v1",
      installationProofKey,
      executionId: request.executionId,
      providerCampaignId,
      providerConfigurationFingerprint:
        request.binding.providerConfigurationFingerprint,
      recipientSetFingerprint: request.binding.recipientSetFingerprint,
    });
  }

  async function readCampaign(
    id: string,
    signal?: AbortSignal,
  ): Promise<CampaignRead> {
    const response = await fetcher(`${endpoint}/emailCampaigns/${id}`, {
      method: "GET",
      headers: headers(apiKey),
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.status === 404) return { outcome: "not_found" } as const;
    if (!response.ok) {
      return {
        outcome: "ambiguous",
        ...(response.status === 429
          ? { code: "provider_rate_limited" }
          : {}),
      } as const;
    }
    return {
      outcome: "found",
      campaign: (await json(response)) as BrevoCampaign,
    } as const;
  }

  async function findCampaign(
    request: NewsletterTestRequest,
  ): Promise<CampaignRead> {
    const response = await fetcher(
      `${endpoint}/emailCampaigns?type=classic&status=draft&limit=50&sort=desc`,
      { method: "GET", headers: headers(apiKey) },
    );
    if (!response.ok) {
      return {
        outcome: "ambiguous",
        ...(response.status === 429
          ? { code: "provider_rate_limited" }
          : {}),
      };
    }
    const body = await json(response) as {
      campaigns?: ReadonlyArray<BrevoCampaign>;
      count?: unknown;
    } | null;
    const matches = (body?.campaigns ?? []).filter(
      (campaign) =>
        campaign.name === campaignName(request.executionId) &&
        campaign.tag === campaignTag(request.executionId),
    );
    if (matches.length === 1) {
      return { outcome: "found", campaign: matches[0]! };
    }
    if (matches.length > 1) return { outcome: "ambiguous" };
    const returned = body?.campaigns?.length ?? 0;
    return typeof body?.count === "number" && body.count <= returned
      ? { outcome: "not_found" }
      : { outcome: "ambiguous" };
  }

  async function reconcile(
    request: NewsletterTestRequest,
    campaignId: string | null,
    foundrySendProof: string | null = request.foundrySendProof,
  ) {
    const senderId = expectedSenderId(request, senderIds);
    if (senderId === null) {
      return { outcome: "rejected", code: "provider_sender_unmapped" } as const;
    }
    const read =
      campaignId === null
        ? await findCampaign(request)
        : await readCampaign(campaignId);
    if (read.outcome === "ambiguous") {
      return {
        outcome: "ambiguous",
        ...(campaignId === null ? {} : { providerCampaignId: campaignId }),
        ...(foundrySendProof === null ? {} : { foundrySendProof }),
        ...(read.code === undefined ? {} : { code: read.code }),
      } as const;
    }
    if (read.outcome === "not_found") {
      return campaignId === null
        ? read
        : {
            outcome: "ambiguous",
            providerCampaignId: campaignId,
            ...(foundrySendProof === null ? {} : { foundrySendProof }),
          } as const;
    }
    const campaign = read.campaign;
    if (!matchesCampaign(campaign, request, senderId)) {
      return {
        outcome: "rejected",
        code: "provider_campaign_fingerprint_mismatch",
      } as const;
    }
    const id = providerId(campaign.id);
    if (campaign.testSent === false && id !== null) {
      return foundrySendProof === null
        ? { outcome: "not_sent", providerCampaignId: id } as const
        : {
            outcome: "ambiguous",
            providerCampaignId: id,
            foundrySendProof,
          } as const;
    }
    return {
      outcome: "ambiguous",
      ...(id === null ? {} : { providerCampaignId: id }),
      ...(foundrySendProof === null ? {} : { foundrySendProof }),
    } as const;
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
      const senderId = expectedSenderId(request, senderIds);
      if (senderId === null) {
        return { outcome: "rejected", code: "provider_sender_unmapped" };
      }
      let campaignId: string | null = request.providerCampaignId;
      const signal = AbortSignal.timeout(30_000);
      try {
        if (campaignId === null) {
          const created = await fetcher(`${endpoint}/emailCampaigns`, {
            method: "POST",
            headers: headers(apiKey),
            signal,
            body: JSON.stringify({
              name: campaignName(request.executionId),
              tag: campaignTag(request.executionId),
              sender: { id: senderId },
              subject: request.subject,
              previewText: request.previewText,
              htmlContent: request.renderedCampaign.html.bytes,
            }),
          });
          if (!created.ok) {
            if (outcomeCouldBeAmbiguous(created.status)) {
              return {
                outcome: "ambiguous",
                ...(created.status === 429
                  ? { code: "provider_rate_limited" }
                  : {}),
              } as const;
            }
            return {
              outcome: "rejected",
              code: "provider_campaign_create_rejected",
            } as const;
          }
          const createdBody = await json(created) as { id?: unknown } | null;
          campaignId = providerId(createdBody?.id);
          if (campaignId === null) return { outcome: "ambiguous" };
        } else {
          const existing = await readCampaign(campaignId, signal);
          if (existing.outcome === "ambiguous") {
            return {
              outcome: "ambiguous",
              providerCampaignId: campaignId,
              ...(existing.code === undefined
                ? {}
                : { code: existing.code }),
            } as const;
          }
          if (
            existing.outcome !== "found" ||
            !matchesCampaign(existing.campaign, request, senderId)
          ) {
            return {
              outcome: "rejected",
              code:
                existing.outcome === "not_found"
                  ? "provider_campaign_not_found"
                  : "provider_campaign_fingerprint_mismatch",
            } as const;
          }
        }
        return {
          outcome: "prepared",
          providerCampaignId: campaignId,
          foundrySendProof: await foundrySendProof(request, campaignId),
        } as const;
      } catch {
        return {
          outcome: "ambiguous",
          ...(campaignId === null ? {} : { providerCampaignId: campaignId }),
        } as const;
      }
    },
    async sendTest(request) {
      const senderId = expectedSenderId(request, senderIds);
      const campaignId = request.providerCampaignId;
      const sendProof = request.foundrySendProof;
      if (senderId === null) {
        return { outcome: "rejected", code: "provider_sender_unmapped" };
      }
      if (
        campaignId === null ||
        sendProof === null ||
        sendProof !== await foundrySendProof(request, campaignId)
      ) {
        return {
          outcome: "rejected",
          code: "foundry_send_proof_invalid",
        } as const;
      }
      const signal = AbortSignal.timeout(30_000);
      try {
        const existing = await readCampaign(campaignId, signal);
        if (existing.outcome === "ambiguous") {
          return {
            outcome: "ambiguous",
            providerCampaignId: campaignId,
            foundrySendProof: sendProof,
            ...(existing.code === undefined ? {} : { code: existing.code }),
          } as const;
        }
        if (
          existing.outcome !== "found" ||
          !matchesCampaign(existing.campaign, request, senderId)
        ) {
          return {
            outcome: "rejected",
            code:
              existing.outcome === "not_found"
                ? "provider_campaign_not_found"
                : "provider_campaign_fingerprint_mismatch",
          } as const;
        }
        const sent = await fetcher(
          `${endpoint}/emailCampaigns/${campaignId}/sendTest`,
          {
            method: "POST",
            headers: headers(apiKey),
            signal,
            body: JSON.stringify({
              emailTo: request.recipients.map(
                (recipient) => recipient.address,
              ),
            }),
          },
        );
        if (!sent.ok) {
          if (outcomeCouldBeAmbiguous(sent.status)) {
            return {
              outcome: "ambiguous",
              providerCampaignId: campaignId,
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
        return accepted(
          request,
          { id: campaignId },
          sendProof,
        );
      } catch {
        return {
          outcome: "ambiguous",
          providerCampaignId: campaignId,
          foundrySendProof: sendProof,
        };
      }
    },
    async reconcileTest({ request, providerCampaignId }) {
      try {
        return await reconcile(request, providerCampaignId);
      } catch {
        return {
          outcome: "ambiguous",
          ...(providerCampaignId === null
            ? {}
            : { providerCampaignId }),
        };
      }
    },
  };
  return Object.freeze(adapter);
}
