import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  createInMemoryNewsletterSignupStore,
  createInMemorySubscriberLedgerStore,
  createNewsletterSignupApplication,
  createSubscriberIdentityKey,
  type NewsletterSignupApplication,
  type NewsletterConfirmationSender,
  type NewsletterSignupStore,
  type SubscriberLedgerStore,
} from "@humber-foundry/application";

import { installedSiteDefinition } from "../foundry/site-definition";
import { createD1NewsletterSignupStore } from "./d1-newsletter-signup-store";
import { createD1SubscriberLedgerStore } from "./d1-subscriber-ledger-store";
import { createSignedNewsletterConfirmationLinks } from "./newsletter-confirmation-token";
import { createBrevoNewsletterConfirmationSender } from "./brevo-newsletter-confirmation-sender";
import {
  readNewsletterConfirmationDelivery,
  readNewsletterSignupReadiness,
  type NewsletterSignupEnvironment,
  type NewsletterSignupReadiness,
} from "./newsletter-signup-readiness";

/**
 * This module carries no `server-only` marker on purpose. The scheduled worker
 * reaches it through `newsletter-confirmation-runtime.ts`, and the worker is
 * not a Next.js server component, so that marker throws there at start-up.
 * `public-form-notification-runtime.ts` is left unmarked for the same reason.
 *
 * Nothing here is reachable from the browser: the public signup form imports
 * only `foundry/newsletter-signup-contract.ts`, and `verify:bundle` checks that
 * boundary on every build.
 *
 * The site id comes from `foundry/site-definition.ts` rather than from
 * `site-definition.server.ts` for the same reason: the server module carries
 * the marker too.
 */

type RateLimitBinding = Readonly<{
  limit(input: { key: string }): Promise<Readonly<{ success: boolean }>>;
}>;

export type NewsletterSignupRuntimeEnvironment = NewsletterSignupEnvironment &
  Readonly<{ FOUNDRY_FORM_RATE_LIMITER?: RateLimitBinding }>;

const localSignupStore = createInMemoryNewsletterSignupStore();
const localLedgerStore = createInMemorySubscriberLedgerStore();

function isLocalDevelopment() {
  return process.env.NODE_ENV === "development";
}

/**
 * The provider that sends confirmation messages, or a sender that refuses when
 * the provider key is absent.
 *
 * With the key absent, `readDelivery` already reports the installation as not
 * configured, so nothing is ever queued and this sender is never called. It is
 * built anyway because the application needs one, and it refuses rather than
 * carry a made-up key that would look like a real credential.
 */
function confirmationSender(
  environment: NewsletterSignupRuntimeEnvironment,
  senders: Readonly<Record<string, { id: number; email: string; name: string }>>,
  fetcher?: typeof fetch,
): NewsletterConfirmationSender {
  const apiKey = environment.FOUNDRY_BREVO_API_KEY?.trim() ?? "";
  if (apiKey === "") {
    return Object.freeze({
      async send() {
        return { outcome: "permanent_failure" as const };
      },
    });
  }
  return createBrevoNewsletterConfirmationSender({
    apiKey,
    senders,
    ...(fetcher === undefined ? {} : { fetcher }),
  });
}

export async function loadNewsletterSignupEnvironment(): Promise<NewsletterSignupRuntimeEnvironment> {
  const { env } = await getCloudflareContext({ async: true });
  return env as NewsletterSignupRuntimeEnvironment;
}

/**
 * Builds the signup application for one request.
 *
 * `readDelivery` is passed as a function rather than a value, so a setting that
 * is removed between two requests is noticed on the next request instead of
 * being held from process start.
 */
export function createNewsletterSignupRuntime({
  environment,
  signupStore,
  ledgerStore,
  identityKeySecret,
  clock,
  createId,
  fetcher,
}: {
  environment: NewsletterSignupRuntimeEnvironment;
  signupStore: NewsletterSignupStore;
  ledgerStore: SubscriberLedgerStore;
  identityKeySecret: string;
  clock?: () => Date;
  createId?: (
    kind: "newsletter_signup" | "subscriber" | "subscriber_event",
  ) => string;
  fetcher?: typeof fetch;
}): NewsletterSignupApplication {
  const secret = environment.FOUNDRY_NEWSLETTER_DELIVERY_SECRET ?? "";
  const senders = (() => {
    try {
      return JSON.parse(environment.FOUNDRY_BREVO_SENDERS_JSON ?? "{}") as Record<
        string,
        { id: number; email: string; name: string }
      >;
    } catch {
      return {};
    }
  })();

  return createNewsletterSignupApplication({
    siteId: installedSiteDefinition.site.id,
    store: signupStore,
    ledgerStore,
    createIdentityKey: (email) =>
      createSubscriberIdentityKey(email, identityKeySecret),
    confirmationLinks: createSignedNewsletterConfirmationLinks({
      canonicalOrigin: environment.FOUNDRY_CANONICAL_ORIGIN ?? "",
      secret,
    }),
    sender: confirmationSender(environment, senders, fetcher),
    async readDelivery() {
      return readNewsletterConfirmationDelivery(environment);
    },
    ...(clock === undefined ? {} : { clock }),
    ...(createId === undefined ? {} : { createId }),
  });
}

async function loadStores(): Promise<{
  environment: NewsletterSignupRuntimeEnvironment;
  signupStore: NewsletterSignupStore;
  ledgerStore: SubscriberLedgerStore;
  identityKeySecret: string;
}> {
  const environment = await loadNewsletterSignupEnvironment();
  if (environment.FOUNDRY_DB === undefined) {
    throw new Error("newsletter_signup_not_configured");
  }
  return {
    environment,
    signupStore: createD1NewsletterSignupStore(environment.FOUNDRY_DB),
    ledgerStore: createD1SubscriberLedgerStore(environment.FOUNDRY_DB),
    identityKeySecret:
      environment.FOUNDRY_SUBSCRIBER_IDENTITY_SECRET ?? "",
  };
}

export async function loadNewsletterSignupApplication(): Promise<NewsletterSignupApplication> {
  if (isLocalDevelopment()) {
    // Local development has no provider and no database. Signup is reported as
    // unavailable, so this application never takes an address.
    return createNewsletterSignupRuntime({
      environment: {},
      signupStore: localSignupStore,
      ledgerStore: localLedgerStore,
      identityKeySecret: "local-development-subscriber-identity-secret",
    });
  }
  const loaded = await loadStores();
  return createNewsletterSignupRuntime(loaded);
}

/**
 * The rate limit for the public signup form. It uses the same binding as the
 * public contact form, under its own key prefix, so one form cannot spend the
 * other's allowance.
 */
export async function allowNewsletterSignupAttempt(
  environment: NewsletterSignupRuntimeEnvironment,
  key: string,
): Promise<boolean> {
  const limiter = environment.FOUNDRY_FORM_RATE_LIMITER;
  if (limiter === undefined) return false;
  return (await limiter.limit({ key: `newsletter-signup:${key}` })).success;
}
