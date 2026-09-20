import { describe, expect, it } from "vitest";

import { createSiteId } from "@humber-foundry/site-definition";

import {
  createNewsletterSignupApplication,
  createNewsletterSignupRequestId,
  newsletterConfirmationRetryAt,
  NewsletterConfirmationExpiredError,
  NewsletterSignupRejectedError,
  type NewsletterConfirmationMessage,
  type NewsletterConfirmationSender,
  type NewsletterSignupRequestId,
} from "./newsletter-signup";
import { createInMemoryNewsletterSignupStore } from "./in-memory-newsletter-signup-store";
import { createInMemorySubscriberLedgerStore } from "./in-memory-subscriber-ledger-store";
import {
  createSubscriberId,
  createSubscriberEventId,
} from "./subscriber-ledger";

const siteId = createSiteId("site_reference");
const firstSubmission = "3f6c2b3a-6f0f-4a19-9d2b-2f52f4a2a111";
const secondSubmission = "3f6c2b3a-6f0f-4a19-9d2b-2f52f4a2a222";
const address = "reader@example.test";
const otherAddress = "another@example.test";

const disclosure = Object.freeze({
  version: "newsletter-consent-1.0.0",
  surface: "https://example.test/#section_newsletter",
});

function identityKeyFor(email: string) {
  // A stable stand-in for the HMAC the runtime uses. Only its shape matters.
  let hash = 0;
  for (const character of email) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").repeat(8);
}

function createHarness(
  options: {
    delivery?: Readonly<{
      senderIdentityId: string;
      legalFooter: string;
    }> | null;
    sendOutcome?: () => "sent" | "retry" | "permanent_failure";
    sendThrows?: boolean;
    now?: () => Date;
  } = {},
) {
  const store = createInMemoryNewsletterSignupStore();
  const ledgerStore = createInMemorySubscriberLedgerStore();
  const sent: NewsletterConfirmationMessage[] = [];
  const tokens = new Map<
    string,
    { requestId: NewsletterSignupRequestId; identityKey: string }
  >();
  let counter = 0;

  const sender: NewsletterConfirmationSender = {
    async send(message) {
      if (options.sendThrows === true) throw new Error("provider_unreachable");
      sent.push(message);
      return { outcome: options.sendOutcome?.() ?? "sent" };
    },
  };

  const application = createNewsletterSignupApplication({
    siteId,
    store,
    ledgerStore,
    createIdentityKey: async (email) => identityKeyFor(email),
    confirmationLinks: {
      async createConfirmationUrl({ requestId, identityKey }) {
        counter += 1;
        const token = `token-${counter}`;
        tokens.set(token, { requestId, identityKey });
        return `https://example.test/newsletter/confirm?token=${token}`;
      },
      async consumeConfirmationToken(token) {
        const found = tokens.get(token);
        if (found === undefined) throw new TypeError("confirm_token_invalid");
        return found;
      },
    },
    sender,
    async readDelivery() {
      return options.delivery === undefined
        ? { senderIdentityId: "primary", legalFooter: "Studio · Somewhere" }
        : options.delivery;
    },
    clock: options.now ?? (() => new Date("2026-03-01T10:00:00.000Z")),
    createId: (kind) => {
      counter += 1;
      return `${kind}-${counter}`;
    },
  });

  function tokenFor(message: NewsletterConfirmationMessage) {
    return new URL(message.confirmationUrl).searchParams.get("token")!;
  }

  return { application, store, ledgerStore, sent, tokenFor };
}

async function signUpAndSend(
  harness: ReturnType<typeof createHarness>,
  submissionId = firstSubmission,
  email = address,
) {
  await harness.application.requestSignup({
    submissionId,
    email,
    disclosure,
  });
  await harness.application.deliverDueConfirmations({ leaseToken: "lease-1" });
  return harness.sent.at(-1)!;
}

describe("newsletter signup", () => {
  it("does not create a subscriber until the person follows the link", async () => {
    const harness = createHarness();
    const result = await harness.application.requestSignup({
      submissionId: firstSubmission,
      email: address,
      disclosure,
    });

    expect(result.outcome).toBe("check_your_inbox");
    expect(await harness.ledgerStore.listSubscribers(siteId)).toHaveLength(0);

    const message = await signUpAndSend(harness, secondSubmission);
    expect(await harness.ledgerStore.listSubscribers(siteId)).toHaveLength(0);

    await harness.application.confirmSignup({
      token: harness.tokenFor(message),
    });
    const subscribers = await harness.ledgerStore.listSubscribers(siteId);
    expect(subscribers).toHaveLength(1);
    expect(subscribers[0]!.state).toBe("active");
    expect(subscribers[0]!.email).toBe(address);
  });

  it("records the page, the time and the wording version as consent evidence", async () => {
    const harness = createHarness();
    const message = await signUpAndSend(harness);
    await harness.application.confirmSignup({
      token: harness.tokenFor(message),
    });

    const snapshot = await harness.ledgerStore.readSnapshot(siteId);
    const event = snapshot.events.find(
      (candidate) => candidate.type === "consent_recorded",
    )!;
    expect(event.evidence).toMatchObject({
      lawfulBasis: "express",
      source: "public_form",
      disclosureVersion: disclosure.version,
      collectionSurface: disclosure.surface,
      occurredAt: "2026-03-01T10:00:00.000Z",
    });
  });

  it("answers the same way whether or not the address is already on the list", async () => {
    const harness = createHarness();
    const message = await signUpAndSend(harness);
    await harness.application.confirmSignup({
      token: harness.tokenFor(message),
    });

    const again = await harness.application.requestSignup({
      submissionId: secondSubmission,
      email: address,
      disclosure,
    });
    const fresh = await harness.application.requestSignup({
      submissionId: "3f6c2b3a-6f0f-4a19-9d2b-2f52f4a2a333",
      email: otherAddress,
      disclosure,
    });
    expect(again).toStrictEqual(fresh);
  });

  it("answers the same way for an address that can never be added again", async () => {
    const harness = createHarness();
    const identityKey = identityKeyFor(address);
    await harness.ledgerStore.createWithEvent({
      subscriber: {
        id: createSubscriberId("subscriber-erased"),
        siteId,
        identityKey,
        email: null,
        state: "erased",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      event: {
        id: createSubscriberEventId("event-erased"),
        siteId,
        subscriberId: createSubscriberId("subscriber-erased"),
        type: "erased",
        occurredAt: "2026-01-01T00:00:00.000Z",
        recordedAt: "2026-01-01T00:00:00.000Z",
        actor: { type: "provider", provider: "test", providerEventId: "e1" },
        evidence: null,
      },
    });

    const refused = await harness.application.requestSignup({
      submissionId: firstSubmission,
      email: address,
      disclosure,
    });
    const accepted = await harness.application.requestSignup({
      submissionId: secondSubmission,
      email: otherAddress,
      disclosure,
    });
    expect(refused).toStrictEqual(accepted);

    // No confirmation message is sent and no address is kept.
    await harness.application.deliverDueConfirmations({ leaseToken: "lease" });
    expect(harness.sent.map((message) => message.address)).toStrictEqual([
      otherAddress,
    ]);
    const subscribers = await harness.ledgerStore.listSubscribers(siteId);
    expect(subscribers.map((subscriber) => subscriber.state)).toStrictEqual([
      "erased",
    ]);
  });

  it("needs a fresh confirmation before an unsubscribed address comes back", async () => {
    const harness = createHarness();
    const first = await signUpAndSend(harness);
    await harness.application.confirmSignup({ token: harness.tokenFor(first) });

    const identityKey = identityKeyFor(address);
    const subscriber = (await harness.ledgerStore.findByIdentityKey({
      siteId,
      identityKey,
    }))!;
    await harness.ledgerStore.appendEvent({
      subscriber: { ...subscriber, state: "unsubscribed" },
      event: {
        id: createSubscriberEventId("event-unsub"),
        siteId,
        subscriberId: subscriber.id,
        type: "unsubscribed",
        occurredAt: "2026-02-01T00:00:00.000Z",
        recordedAt: "2026-02-01T00:00:00.000Z",
        actor: { type: "provider", provider: "test", providerEventId: "u1" },
        evidence: null,
      },
    });

    const second = await signUpAndSend(harness, secondSubmission);
    expect(
      (await harness.ledgerStore.findByIdentityKey({ siteId, identityKey }))!
        .state,
    ).toBe("unsubscribed");

    await harness.application.confirmSignup({ token: harness.tokenFor(second) });
    expect(
      (await harness.ledgerStore.findByIdentityKey({ siteId, identityKey }))!
        .state,
    ).toBe("active");
  });

  it("refuses a confirmation link after the pending request expires", async () => {
    let now = new Date("2026-03-01T10:00:00.000Z");
    const harness = createHarness({ now: () => now });
    const message = await signUpAndSend(harness);

    now = new Date("2026-03-03T10:00:00.000Z");
    await expect(
      harness.application.confirmSignup({ token: harness.tokenFor(message) }),
    ).rejects.toBeInstanceOf(NewsletterConfirmationExpiredError);
    expect(await harness.ledgerStore.listSubscribers(siteId)).toHaveLength(0);
  });

  it("clears the address when a pending request expires", async () => {
    let now = new Date("2026-03-01T10:00:00.000Z");
    const harness = createHarness({ now: () => now });
    await harness.application.requestSignup({
      submissionId: firstSubmission,
      email: address,
      disclosure,
    });

    now = new Date("2026-03-03T10:00:00.000Z");
    await harness.application.deliverDueConfirmations({ leaseToken: "lease" });
    expect(
      harness.store.listSignups().map((signup) => [signup.state, signup.email]),
    ).toStrictEqual([["expired", null]]);
  });

  it("uses a confirmation link only once", async () => {
    const harness = createHarness();
    const message = await signUpAndSend(harness);
    await harness.application.confirmSignup({
      token: harness.tokenFor(message),
    });
    await expect(
      harness.application.confirmSignup({ token: harness.tokenFor(message) }),
    ).rejects.toBeInstanceOf(NewsletterConfirmationExpiredError);
  });

  it("treats a repeated submission id as the same request", async () => {
    const harness = createHarness();
    await harness.application.requestSignup({
      submissionId: firstSubmission,
      email: address,
      disclosure,
    });
    await harness.application.requestSignup({
      submissionId: firstSubmission,
      email: address,
      disclosure,
    });
    expect(harness.store.listSignups()).toHaveLength(1);
  });

  it("does not take an address when the confirmation message cannot be sent", async () => {
    const harness = createHarness({ delivery: null });
    const result = await harness.application.requestSignup({
      submissionId: firstSubmission,
      email: address,
      disclosure,
    });
    expect(result.outcome).toBe("not_available");
    expect(harness.store.listSignups()).toHaveLength(0);
    expect(harness.sent).toHaveLength(0);
  });

  it("refuses an address that is not an address, and a request with no wording version", async () => {
    const harness = createHarness();
    await expect(
      harness.application.requestSignup({
        submissionId: firstSubmission,
        email: "not-an-address",
        disclosure,
      }),
    ).rejects.toBeInstanceOf(NewsletterSignupRejectedError);
    await expect(
      harness.application.requestSignup({
        submissionId: firstSubmission,
        email: address,
        disclosure: { version: "  ", surface: disclosure.surface },
      }),
    ).rejects.toBeInstanceOf(NewsletterSignupRejectedError);
    await expect(
      harness.application.requestSignup({
        submissionId: "not-a-uuid",
        email: address,
        disclosure,
      }),
    ).rejects.toBeInstanceOf(NewsletterSignupRejectedError);
  });

  it("refuses a confirmation token this installation did not sign", async () => {
    const harness = createHarness();
    await expect(
      harness.application.confirmSignup({ token: "made-up" }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("refuses a token whose request id is unknown", async () => {
    const harness = createHarness();
    const store = harness.store;
    expect(store.listSignups()).toHaveLength(0);
    await expect(
      harness.application.confirmSignup({ token: "token-404" }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("retries a confirmation message the provider could not take, without a second send", async () => {
    let attempt = 0;
    const harness = createHarness({
      sendOutcome: () => (attempt++ === 0 ? "retry" : "sent"),
    });
    await harness.application.requestSignup({
      submissionId: firstSubmission,
      email: address,
      disclosure,
    });
    const first = await harness.application.deliverDueConfirmations({
      leaseToken: "lease-1",
    });
    expect(first).toStrictEqual({ sent: 0, retried: 1, failed: 0 });
    expect(harness.store.listJobs()[0]!.status).toBe("pending");
  });

  it("treats an unknown provider answer as retryable", async () => {
    const harness = createHarness({ sendThrows: true });
    await harness.application.requestSignup({
      submissionId: firstSubmission,
      email: address,
      disclosure,
    });
    const outcome = await harness.application.deliverDueConfirmations({
      leaseToken: "lease-1",
    });
    expect(outcome).toStrictEqual({ sent: 0, retried: 1, failed: 0 });
  });

  it("stops retrying after the retry window and clears the address", async () => {
    expect(
      newsletterConfirmationRetryAt({
        attempts: 3,
        firstAvailableAt: "2026-03-01T10:00:00.000Z",
        now: new Date("2026-03-02T11:00:00.000Z"),
      }),
    ).toBeNull();

    const harness = createHarness({ sendOutcome: () => "permanent_failure" });
    await harness.application.requestSignup({
      submissionId: firstSubmission,
      email: address,
      disclosure,
    });
    await harness.application.deliverDueConfirmations({ leaseToken: "lease" });
    expect(harness.store.listJobs()[0]).toMatchObject({
      status: "failed",
      address: "",
    });
  });

  it("supersedes an earlier pending request for the same address", async () => {
    const harness = createHarness();
    await harness.application.requestSignup({
      submissionId: firstSubmission,
      email: address,
      disclosure,
    });
    await harness.application.requestSignup({
      submissionId: secondSubmission,
      email: address,
      disclosure,
    });
    const states = harness.store
      .listSignups()
      .map((signup) => [signup.state, signup.email]);
    expect(states).toStrictEqual([
      ["superseded", null],
      ["pending", address],
    ]);
    expect(harness.store.listJobs()).toHaveLength(1);
  });

  it("keeps the address out of every value the caller can read back", async () => {
    const harness = createHarness();
    const result = await harness.application.requestSignup({
      submissionId: firstSubmission,
      email: address,
      disclosure,
    });
    expect(JSON.stringify(result)).not.toContain(address);

    let rejected: unknown;
    try {
      await harness.application.requestSignup({
        submissionId: secondSubmission,
        email: "bad@@example",
        disclosure,
      });
    } catch (error) {
      rejected = error;
    }
    expect(String(rejected)).not.toContain("bad@@example");
  });

  it("carries the campaign legal footer on the confirmation message", async () => {
    const harness = createHarness();
    const message = await signUpAndSend(harness);
    expect(message.legalFooter).toBe("Studio · Somewhere");
    expect(message.senderIdentityId).toBe("primary");
    expect(message.confirmationUrl.startsWith("https://")).toBe(true);
  });

  it("keeps a confirmation request id out of the subscriber list", async () => {
    const harness = createHarness();
    const message = await signUpAndSend(harness);
    await harness.application.confirmSignup({
      token: harness.tokenFor(message),
    });
    const [subscriber] = await harness.ledgerStore.listSubscribers(siteId);
    expect(subscriber!.id).not.toBe(
      createNewsletterSignupRequestId(String(message.requestId)),
    );
  });
});
