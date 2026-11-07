import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  createPublicFormId,
  createPublicFormApplication,
  type AcceptPublicFormCommand,
} from "@humber-foundry/application";

import { installedPublicForms } from "../foundry/public-forms";
import { installedSiteDefinition } from "../foundry/site-definition";

import { createCloudflareTurnstileVerifier } from "./cloudflare-turnstile";
import type { D1DatabaseBinding } from "./d1-human-access-store";
import { createD1PublicFormAcceptanceStore } from "./d1-public-form-store";
import {
  publicFormPublicStatus,
  type PublicFormPublicStatus,
} from "./public-form-public-status";

type RateLimitBinding = Readonly<{
  limit(input: { key: string }): Promise<Readonly<{ success: boolean }>>;
}>;

type PublicFormEnvironment = Readonly<{
  FOUNDRY_DB?: D1DatabaseBinding;
  FOUNDRY_CANONICAL_ORIGIN?: string;
  FOUNDRY_TURNSTILE_SITE_KEY?: string;
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

/**
 * Whether one declared form can take a message right now.
 *
 * A form block on the site asks this before it draws a field. An unknown form
 * id and a missing setting give the same answer, so nobody can use this to
 * learn which forms a site declares or how it is configured.
 */
export async function readPublicFormStatus(
  formId: string,
): Promise<PublicFormPublicStatus> {
  let environment: PublicFormEnvironment;
  try {
    environment = await loadEnvironment();
  } catch {
    return publicFormPublicStatus(undefined, {});
  }
  return publicFormPublicStatus(
    installedPublicForms.find((form) => form.id === formId),
    environment,
  );
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
    siteId: installedSiteDefinition.site.id,
    definitions: installedPublicForms.map((form) => ({
      id: createPublicFormId(form.id),
      schemaVersion: form.schemaVersion,
      allowedOrigin,
      turnstileHostname: canonicalUrl.hostname,
      turnstileAction: form.turnstileAction,
      fields: form.fields,
    })),
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
