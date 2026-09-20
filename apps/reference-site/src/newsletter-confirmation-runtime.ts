import { createD1NewsletterSignupStore } from "./d1-newsletter-signup-store";
import { createD1SubscriberLedgerStore } from "./d1-subscriber-ledger-store";
import {
  createNewsletterSignupRuntime,
  type NewsletterSignupRuntimeEnvironment,
} from "./newsletter-signup-runtime";

export type NewsletterConfirmationEnvironment =
  NewsletterSignupRuntimeEnvironment;

/**
 * Sends the newsletter confirmation messages that are due, and clears the
 * address of any pending request that has run out of time. The scheduled worker
 * runs this next to the public form notification drain.
 *
 * An installation with a setting missing sends nothing and reports zero,
 * because there is nothing to send: the signup form refused every address.
 */
export async function deliverNewsletterConfirmationsIfDue(
  environment: NewsletterConfirmationEnvironment,
) {
  if (environment.FOUNDRY_DB === undefined) {
    throw new Error("newsletter_signup_not_configured");
  }
  const application = createNewsletterSignupRuntime({
    environment,
    signupStore: createD1NewsletterSignupStore(environment.FOUNDRY_DB),
    ledgerStore: createD1SubscriberLedgerStore(environment.FOUNDRY_DB),
    identityKeySecret: environment.FOUNDRY_SUBSCRIBER_IDENTITY_SECRET ?? "",
  });
  return application.deliverDueConfirmations({
    leaseToken: crypto.randomUUID(),
  });
}
