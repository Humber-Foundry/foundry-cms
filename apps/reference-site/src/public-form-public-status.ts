import type { InstalledPublicFormDefinition } from "@humber-foundry/application";

import { isHttpsUrl, isPresent } from "./settings-presence";

/**
 * What a public form block on the site is allowed to know before a visitor
 * types anything.
 *
 * A visitor is told whether the form works and, when it does, the three
 * values the block needs to send a message the server will accept: the form's
 * schema version, the automated-traffic check's action name, and the public
 * Turnstile site key the widget needs. Every other configuration detail stays
 * on the server: how a site is configured is none of a visitor's business.
 *
 * The form asks this before it shows a field, the same way the newsletter
 * signup form does. A field that looks ready and then refuses every message is
 * worse than a plain sentence saying the form is not ready.
 */
export type PublicFormPublicStatus = Readonly<{
  available: boolean;
  schemaVersion: string | null;
  /**
   * The action name the widget must claim. The server refuses a message whose
   * check reports any other action, so the block cannot guess this.
   */
  turnstileAction: string | null;
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

const notAvailable: PublicFormPublicStatus = Object.freeze({
  available: false,
  schemaVersion: null,
  turnstileAction: null,
  turnstileSiteKey: null,
});

export function publicFormPublicStatus(
  form: InstalledPublicFormDefinition | undefined,
  environment: PublicFormStatusEnvironment,
): PublicFormPublicStatus {
  const siteKey = environment.FOUNDRY_TURNSTILE_SITE_KEY?.trim() ?? "";
  const available =
    form !== undefined &&
    environment.FOUNDRY_DB !== undefined &&
    environment.FOUNDRY_FORM_RATE_LIMITER !== undefined &&
    isHttpsUrl(environment.FOUNDRY_CANONICAL_ORIGIN) &&
    siteKey !== "" &&
    // The widget needs both halves of the pair. With the site key alone the
    // form would look ready and then refuse every message at the last moment.
    isPresent(environment.FOUNDRY_TURNSTILE_SECRET);
  // `form` is checked again by name, because `available` is one boolean and
  // does not tell the type checker which of its parts held.
  if (!available || form === undefined) {
    return notAvailable;
  }
  return Object.freeze({
    available: true,
    schemaVersion: form.schemaVersion,
    turnstileAction: form.turnstileAction,
    turnstileSiteKey: siteKey,
  });
}
