import { NewsletterSignupRejectedError } from "@humber-foundry/application";

import {
  newsletterConsentWordings,
} from "../../../../foundry/newsletter-consent-wordings";
import {
  newsletterConsentWordingMaximumLength,
  newsletterSignupMaximumBodySize,
  newsletterSignupMinimumFillTimeMs,
  newsletterSignupSchemaVersion,
  newsletterSignupTurnstileAction,
} from "../../../../foundry/newsletter-signup-contract";

import { createCloudflareTurnstileVerifier } from "../../../../src/cloudflare-turnstile";
import {
  allowNewsletterSignupAttempt,
  loadNewsletterSignupApplication,
  loadNewsletterSignupEnvironment,
} from "../../../../src/newsletter-signup-runtime";
import { readNewsletterSignupReadiness } from "../../../../src/newsletter-signup-readiness";
import { publicNewsletterSignupStatus as publicStatus } from "../../../../src/newsletter-signup-public-status";

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


type SignupEnvelope = Readonly<{
  schemaVersion: string;
  submissionId: string;
  email: string;
  consentWording: string;
  collectionSurface: string;
  turnstileToken: string;
  honeypot: string;
  startedAt: string;
}>;

const envelopeKeys = [
  "schemaVersion",
  "submissionId",
  "email",
  "consentWording",
  "collectionSurface",
  "turnstileToken",
  "honeypot",
  "startedAt",
] as const;

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
    declared > newsletterSignupMaximumBodySize
  ) {
    throw new NewsletterSignupRejectedError("invalid_request");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > newsletterSignupMaximumBodySize) {
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
      publicStatus(
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
    Date.now() - startedAt < newsletterSignupMinimumFillTimeMs
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

  // The consent sentence recorded against a person must be one this site
  // actually shows. The form sends the sentence it displayed; it is kept only
  // when it matches a sentence in this site's own published pages, so a caller
  // cannot write words of their own into somebody's consent record.
  const consentWording = value.consentWording.trim();
  if (
    consentWording.length > newsletterConsentWordingMaximumLength ||
    !newsletterConsentWordings().includes(consentWording)
  ) {
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
      verified.action !== newsletterSignupTurnstileAction
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
      disclosure: { wording: consentWording, surface: collectionSurface },
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
