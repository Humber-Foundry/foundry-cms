/**
 * The agreement between the public signup form and the route that accepts it.
 *
 * The form runs in the browser and the route runs on the server. Both read
 * these values from here, so a change to the envelope or the Turnstile action
 * cannot reach one side and miss the other.
 *
 * This module is browser-safe. Keep secrets, bindings and server adapters out
 * of it.
 */

export const newsletterSignupSchemaVersion = "1.0.0";

/** The Turnstile action name. A token solved for another form is refused. */
export const newsletterSignupTurnstileAction = "newsletter-signup";

/** The longest signup body the route will read, in bytes. */
export const newsletterSignupMaximumBodySize = 4 * 1_024;

/**
 * How long a person must have had the form on screen before a submission is
 * believable. A form filled faster than this was not filled by a person.
 */
export const newsletterSignupMinimumFillTimeMs = 2_000;

/** The longest consent sentence this form will carry. */
export const newsletterConsentWordingMaximumLength = 400;
