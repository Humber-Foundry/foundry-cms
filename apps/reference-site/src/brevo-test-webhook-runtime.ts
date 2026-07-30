import {
  sha256CanonicalJson,
  sha256Text,
} from "@foundry/application";

import {
  brevoTestRecipientFingerprint,
  type BrevoTestWebhookEvidenceStore,
} from "./brevo-test-webhook-evidence";
import { createD1BrevoTestWebhookEvidenceStore } from "./d1-brevo-test-webhook-evidence-store";
import { loadHumanAccessEnvironment } from "./human-access-environment";
import { referenceSiteApplication } from "./reference-installation";

const maximumWebhookBytes = 256 * 1024;
const proofHeaderPattern =
  /^foundry_execution:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\|foundry_proof:([0-9a-f]{64})$/u;

async function sameSecret(left: string, right: string) {
  const [leftHash, rightHash] = await Promise.all([
    sha256Text(`foundry.brevo-webhook-auth.v1:${left}`),
    sha256Text(`foundry.brevo-webhook-auth.v1:${right}`),
  ]);
  let difference = leftHash.length ^ rightHash.length;
  for (let index = 0; index < leftHash.length; index += 1) {
    difference |=
      leftHash.charCodeAt(index) ^ (rightHash.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function string(value: unknown, maximum: number) {
  return typeof value === "string" &&
      value.length > 0 &&
      value.length <= maximum
    ? value
    : null;
}

function tags(event: Record<string, unknown>): ReadonlyArray<string> {
  if (
    Array.isArray(event.tags) &&
    event.tags.every((tag) => typeof tag === "string")
  ) {
    return event.tags;
  }
  if (typeof event.tag !== "string") return [];
  try {
    const parsed = JSON.parse(event.tag) as unknown;
    return Array.isArray(parsed) &&
        parsed.every((tag) => typeof tag === "string")
      ? parsed
      : [event.tag];
  } catch {
    return [event.tag];
  }
}

function providerOccurredAt(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  const date = new Date(value * 1_000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function providerEventId(event: Record<string, unknown>) {
  for (const key of ["event-id", "eventId"]) {
    const candidate = string(event[key], 512);
    if (candidate !== null) return candidate;
  }
  return null;
}

export function createBrevoTestWebhookHandler({
  authenticationToken,
  installationProofKey,
  store,
  clock = () => new Date(),
}: {
  authenticationToken: string;
  installationProofKey: string;
  store: BrevoTestWebhookEvidenceStore;
  clock?: () => Date;
}) {
  if (
    authenticationToken.length < 32 ||
    installationProofKey.length < 32
  ) {
    throw new Error("brevo_webhook_configuration_invalid");
  }
  return async function handle(request: Request) {
    const authorization = request.headers.get("authorization") ?? "";
    const presented = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";
    if (!await sameSecret(presented, authenticationToken)) {
      return new Response(null, { status: 401 });
    }
    const declaredLength = Number(request.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > maximumWebhookBytes
    ) {
      return new Response(null, { status: 413 });
    }
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > maximumWebhookBytes) {
      return new Response(null, { status: 413 });
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(text) as unknown;
    } catch {
      return Response.json({ error: "webhook_payload_invalid" }, {
        status: 400,
      });
    }
    const candidates = Array.isArray(decoded) ? decoded : [decoded];
    if (
      candidates.length === 0 ||
      candidates.length > 100 ||
      candidates.some(
        (candidate) => typeof candidate !== "object" || candidate === null,
      )
    ) {
      return Response.json({ error: "webhook_payload_invalid" }, {
        status: 400,
      });
    }
    const receivedAt = clock().toISOString();
    for (const candidate of candidates) {
      const event = candidate as Record<string, unknown>;
      const proofHeader = string(event["X-Mailin-custom"], 512);
      const proofMatch = proofHeader?.match(proofHeaderPattern) ?? null;
      const providerMessageId = string(event["message-id"], 512);
      const recipient = string(event.email, 320);
      const eventType = string(event.event, 100);
      if (
        proofMatch === null ||
        providerMessageId === null ||
        recipient === null ||
        eventType === null ||
        !tags(event).includes(proofMatch[1]!)
      ) {
        continue;
      }
      const executionId = proofMatch[1]!;
      const foundrySendProof = proofMatch[2]!;
      const recipientFingerprint = await brevoTestRecipientFingerprint(
        installationProofKey,
        recipient,
      );
      const providerTimestamp = providerOccurredAt(event.ts_event);
      const eventOccurredAt = providerTimestamp ?? receivedAt;
      const eventId = providerEventId(event);
      const eventFingerprint = await sha256CanonicalJson({
        version: "foundry.brevo-test-webhook-event.v2",
        siteId: referenceSiteApplication.siteId,
        executionId,
        foundrySendProof,
        identity:
          eventId === null
            ? {
                kind: "stable_payload",
                providerMessageId,
                recipientFingerprint,
                eventType,
                providerTimestamp,
              }
            : {
                kind: "provider_event_id",
                providerEventId: eventId,
                providerMessageId,
                recipientFingerprint,
                eventType,
              },
      });
      await store.recordVerified({
        eventFingerprint,
        siteId: referenceSiteApplication.siteId,
        executionId,
        foundrySendProof,
        providerMessageId,
        recipientFingerprint,
        eventType,
        occurredAt: eventOccurredAt,
        receivedAt,
      });
    }
    return new Response(null, { status: 204 });
  };
}

export async function handleBrevoTestWebhook(request: Request) {
  const environment = await loadHumanAccessEnvironment();
  const authenticationToken =
    environment.FOUNDRY_BREVO_WEBHOOK_AUTH_TOKEN ?? "";
  const authorization = request.headers.get("authorization") ?? "";
  const presented = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  if (
    authenticationToken.length < 32 ||
    !await sameSecret(presented, authenticationToken)
  ) {
    return new Response(null, { status: 401 });
  }
  if (environment.FOUNDRY_DB === undefined) {
    return new Response(null, { status: 503 });
  }
  return createBrevoTestWebhookHandler({
    authenticationToken,
    installationProofKey:
      environment.FOUNDRY_CAMPAIGN_TEST_PROOF_KEY ?? "",
    store: createD1BrevoTestWebhookEvidenceStore({
      database: environment.FOUNDRY_DB,
      siteId: referenceSiteApplication.siteId,
    }),
  })(request);
}
