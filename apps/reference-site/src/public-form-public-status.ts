import type { InstalledPublicFormDefinition } from "@humber-foundry/application";

import { isHttpsUrl, isPresent } from "./settings-presence";

/**
 * What a public form block on the site is allowed to know before a visitor
 * types anything.
 *
 * A visitor is told whether the form works and, when it does, the form's
 * schema version and the public Turnstile site key the widget needs. Every
 * other configuration detail stays on the server: how a site is configured is
 * none of a visitor's business.
 *
 * The form asks this before it shows a field, the same way the newsletter
 * signup form does. A field that looks ready and then refuses every message is
 * worse than a plain sentence saying the form is not ready.
 */
export type PublicFormPublicStatus = Readonly<{
  available: boolean;
  schemaVersion: string | null;
  turnstileSiteKey: string | null;
}>;

/**
 * The settings a form needs before it can take a message. They are the same
 * settings `acceptPublicFormSubmission` requires, so a form reported as
 * working here cannot be refused by the route for a missing setting.
 */
export type PublicFormStatusEnvironment = Readonly<{
  FOUNDRY_DB?: unknown;
  FOUNDRY_FORM_RATE_LIMITER?: unknown;
  FOUNDRY_CANONICAL_ORIGIN?: string;
  FOUNDRY_TURNSTILE_SITE_KEY?: string;
  FOUNDRY_TURNSTILE_SECRET?: string;
}>;

export function publicFormPublicStatus(
  form: InstalledPublicFormDefinition | undefined,
  environment: PublicFormStatusEnvironment,
): PublicFormPublicStatus {
  const available =
    form !== undefined &&
    environment.FOUNDRY_DB !== undefined &&
    environment.FOUNDRY_FORM_RATE_LIMITER !== undefined &&
    isHttpsUrl(environment.FOUNDRY_CANONICAL_ORIGIN) &&
    isPresent(environment.FOUNDRY_TURNSTILE_SITE_KEY) &&
    // The widget needs both halves of the pair. With the site key alone the
    // form would look ready and then refuse every message at the last moment.
    isPresent(environment.FOUNDRY_TURNSTILE_SECRET);
  return Object.freeze({
    available,
    schemaVersion: available ? form!.schemaVersion : null,
    turnstileSiteKey: available
      ? (environment.FOUNDRY_TURNSTILE_SITE_KEY?.trim() ?? null)
      : null,
  });
}
