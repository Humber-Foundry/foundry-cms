import {
  NewsletterSignupRejectedError,
  publicFormMaximumBodySize,
} from "@humber-foundry/application";

import { createCloudflareTurnstileVerifier } from "../../../../src/cloudflare-turnstile";
import {
  allowNewsletterSignupAttempt,
  loadNewsletterSignupApplication,
  loadNewsletterSignupEnvironment,
  publicNewsletterSignupStatus,
} from "../../../../src/newsletter-signup-runtime";
import { readNewsletterSignupReadiness } from "../../../../src/newsletter-signup-readiness";

/**
 * The public newsletter signup route.
 *
 * It reuses the public form's acceptance rules: a Turnstile token the server
 * checks itself, a rate limit on the caller's address, a honeypot, a minimum
 * fill time, and a client-supplied submission id that makes a retry idempotent.
 *
 * The success answer never depends on the address. A new address, an address
 * already on the list, and an address that can never be added again all return
 * the same body, so nobody can use this route to find out who is subscribed.
 * No response, log line or error message contains the submitted address.
 */

const turnstileAction = "newsletter-signup";
const minimumFillTimeMs = 2_000;
const maximumBodySize = 4 * 1_024;

type SignupEnvelope = Readonly<{
  schemaVersion: string;
  submissionId: string;
  email: string;
  disclosureVersion: string;
  collectionSurface: string;
  turnstileToken: string;
  honeypot: string;
  startedAt: string;
}>;

const envelopeKeys = [
  "schemaVersion",
  "submissionId",
  "email",
  "disclosureVersion",
  "collectionSurface",
  "turnstileToken",
  "honeypot",
  "startedAt",
] as const;

export const newsletterSignupSchemaVersion = "1.0.0";

function isSignupEnvelope(value: unknown): value is SignupEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === envelopeKeys.length &&
    envelopeKeys.every((key) => typeof record[key] === "string")
  );
}

function publicJson(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new NewsletterSignupRejectedError("invalid_request");
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (
    Number.isFinite(declared) &&
    declared > Math.min(maximumBodySize, publicFormMaximumBodySize)
  ) {
    throw new NewsletterSignupRejectedError("invalid_request");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maximumBodySize) {
    throw new NewsletterSignupRejectedError("invalid_request");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new NewsletterSignupRejectedError("invalid_request");
  }
}

/** Tells the public form whether signup works, and nothing else. */
export async function GET() {
  try {
    const environment = await loadNewsletterSignupEnvironment();
    return publicJson(
      publicNewsletterSignupStatus(
        readNewsletterSignupReadiness(environment),
        environment,
      ),
      200,
    );
  } catch {
    return publicJson({ available: false, turnstileSiteKey: null }, 200);
  }
}

export async function POST(request: Request) {
  let environment;
  try {
    environment = await loadNewsletterSignupEnvironment();
  } catch {
    return publicJson({ error: "signup_not_available" }, 503);
  }

  const readiness = readNewsletterSignupReadiness(environment);
  if (readiness.state !== "connected") {
    // No confirmation message can be sent, so no address is read from the body.
    return publicJson({ error: "signup_not_available" }, 503);
  }

  const canonicalOrigin = environment.FOUNDRY_CANONICAL_ORIGIN!.trim();
  if ((request.headers.get("origin") ?? "") !== canonicalOrigin) {
    return publicJson({ error: "signup_rejected" }, 400);
  }

  let value: unknown;
  try {
    value = await readBoundedJson(request);
  } catch {
    return publicJson({ error: "signup_rejected" }, 400);
  }
  if (
    !isSignupEnvelope(value) ||
    value.schemaVersion !== newsletterSignupSchemaVersion ||
    value.honeypot !== "" ||
    value.turnstileToken.length < 1 ||
    value.turnstileToken.length > 2_048
  ) {
    return publicJson({ error: "signup_rejected" }, 400);
  }

  const startedAt = Date.parse(value.startedAt);
  if (
    !Number.isFinite(startedAt) ||
    Date.now() - startedAt < minimumFillTimeMs
  ) {
    return publicJson({ error: "signup_rejected" }, 400);
  }

  // Consent evidence has to say where the person actually was. The page the
  // form reports is only kept when it is a page on this site, so a caller
  // cannot write somebody else's address into the record.
  const collectionSurface = (() => {
    try {
      const surface = new URL(value.collectionSurface, canonicalOrigin);
      return surface.origin === new URL(canonicalOrigin).origin
        ? surface.toString()
        : null;
    } catch {
      return null;
    }
  })();
  if (collectionSurface === null) {
    return publicJson({ error: "signup_rejected" }, 400);
  }

  const caller = request.headers.get("cf-connecting-ip") ?? "unknown";
  let allowed: boolean;
  try {
    allowed = await allowNewsletterSignupAttempt(environment, caller);
  } catch {
    return publicJson({ error: "temporarily_unavailable" }, 503);
  }
  if (!allowed) {
    return publicJson({ error: "temporarily_unavailable" }, 429);
  }

  try {
    const verified = await createCloudflareTurnstileVerifier({
      secret: environment.FOUNDRY_TURNSTILE_SECRET ?? "",
    }).verify({
      token: value.turnstileToken,
      idempotencyKey: value.submissionId,
    });
    if (!verified.success) {
      return publicJson({ error: "temporarily_unavailable" }, 503);
    }
    if (
      verified.hostname !== new URL(canonicalOrigin).hostname ||
      verified.action !== turnstileAction
    ) {
      return publicJson({ error: "signup_rejected" }, 400);
    }
  } catch {
    // The check could not run. Fail closed rather than take an unchecked
    // address.
    return publicJson({ error: "temporarily_unavailable" }, 503);
  }

  try {
    const application = await loadNewsletterSignupApplication();
    const result = await application.requestSignup({
      submissionId: value.submissionId,
      email: value.email,
      disclosure: {
        version: value.disclosureVersion,
        surface: collectionSurface,
      },
    });
    if (result.outcome === "not_available") {
      return publicJson({ error: "signup_not_available" }, 503);
    }
    return publicJson({ status: "check_your_inbox" }, 202);
  } catch (error) {
    if (error instanceof NewsletterSignupRejectedError) {
      // The reason is not returned, and the address is never echoed back. A
      // badly formed address is refused; an address that is already on the list
      // gets the same 202 as a new one.
      return publicJson({ error: "signup_rejected" }, 400);
    }
    return publicJson({ error: "temporarily_unavailable" }, 503);
  }
}
