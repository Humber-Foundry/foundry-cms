import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  createPublicFormId,
  createPublicFormApplication,
  type AcceptPublicFormCommand,
} from "@foundry/application";
import { referenceSiteDefinition } from "@foundry/site-definition";

import { createCloudflareTurnstileVerifier } from "./cloudflare-turnstile";
import type { D1DatabaseBinding } from "./d1-human-access-store";
import { createD1PublicFormAcceptanceStore } from "./d1-public-form-store";

type RateLimitBinding = Readonly<{
  limit(input: { key: string }): Promise<Readonly<{ success: boolean }>>;
}>;

type PublicFormEnvironment = Readonly<{
  FOUNDRY_DB?: D1DatabaseBinding;
  FOUNDRY_CANONICAL_ORIGIN?: string;
  FOUNDRY_TURNSTILE_SECRET?: string;
  FOUNDRY_FORM_RATE_LIMITER?: RateLimitBinding;
}>;

function requireSetting(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new Error("public_form_not_configured");
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function loadEnvironment(): Promise<PublicFormEnvironment> {
  const { env } = await getCloudflareContext({ async: true });
  return env as PublicFormEnvironment;
}

export async function acceptPublicFormSubmission(
  command: AcceptPublicFormCommand,
) {
  const environment = await loadEnvironment();
  if (
    environment.FOUNDRY_DB === undefined ||
    environment.FOUNDRY_FORM_RATE_LIMITER === undefined
  ) {
    throw new Error("public_form_not_configured");
  }
  const allowedOrigin = requireSetting(environment.FOUNDRY_CANONICAL_ORIGIN);
  const canonicalUrl = new URL(allowedOrigin);
  if (canonicalUrl.protocol !== "https:") {
    throw new Error("public_form_not_configured");
  }
  const application = createPublicFormApplication({
    siteId: referenceSiteDefinition.site.id,
    definitions: [
      {
        id: createPublicFormId("contact"),
        schemaVersion: "1.0.0",
        allowedOrigin,
        turnstileHostname: canonicalUrl.hostname,
        turnstileAction: "contact",
        fields: [
          { id: "name", required: true, maximumLength: 100 },
          { id: "message", required: true, maximumLength: 2_000 },
        ],
      },
    ],
    store: createD1PublicFormAcceptanceStore(environment.FOUNDRY_DB),
    rateLimiter: {
      async allow({ key }) {
        return (
          await environment.FOUNDRY_FORM_RATE_LIMITER!.limit({ key })
        ).success;
      },
    },
    turnstile: createCloudflareTurnstileVerifier({
      secret: requireSetting(environment.FOUNDRY_TURNSTILE_SECRET),
    }),
    clock: () => new Date(),
    createId: (kind) => `${kind}_${crypto.randomUUID()}`,
    hash: sha256,
  });
  return application.commands.accept(command);
}
