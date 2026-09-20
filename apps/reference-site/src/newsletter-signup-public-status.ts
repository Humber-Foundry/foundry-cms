import type { NewsletterSignupEnvironment, NewsletterSignupReadiness } from "./newsletter-signup-readiness";

/**
 * What the public form is allowed to know. A visitor is told whether signup
 * works and, when it does, the public Turnstile site key the widget needs.
 * Setting names and every other configuration detail stay on the server: how a
 * site is configured is none of a visitor's business.
 */
export type PublicNewsletterSignupStatus = Readonly<{
  available: boolean;
  turnstileSiteKey: string | null;
}>;

export function publicNewsletterSignupStatus(
  readiness: NewsletterSignupReadiness,
  environment: NewsletterSignupEnvironment,
): PublicNewsletterSignupStatus {
  const available = readiness.state === "connected";
  return Object.freeze({
    available,
    turnstileSiteKey: available
      ? (environment.FOUNDRY_TURNSTILE_SITE_KEY?.trim() ?? null)
      : null,
  });
}
