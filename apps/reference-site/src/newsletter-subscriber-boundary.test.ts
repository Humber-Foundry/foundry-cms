import { describe, expect, it } from "vitest";

import {
  createInMemoryNewsletterSignupStore,
  createInMemorySubscriberLedgerStore,
  createNewsletterSignupApplication,
  createSubscriberLedgerAudienceResolver,
  type NewsletterConfirmationMessage,
  type NewsletterSignupRequestId,
} from "@humber-foundry/application";
import { referenceSiteDefinition } from "@humber-foundry/site-definition";

import { createCampaignBulkAudience } from "./campaign-bulk-audience";
import {
  createMcpToolRegistry,
  type McpReadApplication,
} from "./mcp-tool-registry";

/**
 * The boundary this ticket has to hold.
 *
 * A bulk send reaches confirmed subscribers only, and an agent sees how many
 * there are without ever seeing who they are.
 */

const siteId = referenceSiteDefinition.site.id;
const address = "reader@example.test";
const disclosure = Object.freeze({
  version: "newsletter-consent-1.0.0",
  surface: "https://example.test/#section_newsletter",
});
const audienceDefinition = Object.freeze({
  id: "canonical-consent-and-suppression",
  version: 1 as const,
});

function identityKeyFor(email: string) {
  let hash = 0;
  for (const character of email) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").repeat(8);
}

function harness() {
  const store = createInMemoryNewsletterSignupStore();
  const ledgerStore = createInMemorySubscriberLedgerStore();
  const sent: NewsletterConfirmationMessage[] = [];
  const tokens = new Map<
    string,
    { requestId: NewsletterSignupRequestId; identityKey: string }
  >();
  let counter = 0;

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
    sender: {
      async send(message) {
        sent.push(message);
        return { outcome: "sent" };
      },
    },
    async readDelivery() {
      return { senderIdentityId: "primary", legalFooter: "Studio · Town" };
    },
    createId: (kind) => {
      counter += 1;
      return `${kind}-${counter}`;
    },
  });

  return { application, ledgerStore, sent, tokens };
}

describe("a bulk send reaches confirmed subscribers only", () => {
  it("leaves a pending signup out of the audience, and admits it after confirmation", async () => {
    const { application, ledgerStore, sent } = harness();
    const audience = createCampaignBulkAudience({ siteId, store: ledgerStore });
    const resolver = createSubscriberLedgerAudienceResolver({
      siteId,
      store: ledgerStore,
    });

    await application.requestSignup({
      submissionId: "3f6c2b3a-6f0f-4a19-9d2b-2f52f4a2a111",
      email: address,
      disclosure,
    });
    await application.deliverDueConfirmations({ leaseToken: "lease" });

    // The confirmation message has gone out. The person is still not a
    // recipient, and the count an agent could read is still zero.
    expect(
      await audience.resolve({ audienceDefinition } as never),
    ).toStrictEqual([]);
    expect(await resolver(audienceDefinition)).toStrictEqual({
      eligibleSubscriberCount: 0,
    });

    const token = new URL(sent[0]!.confirmationUrl).searchParams.get("token")!;
    await application.confirmSignup({ token });

    const recipients = await audience.resolve({ audienceDefinition } as never);
    expect(recipients).toHaveLength(1);
    expect(recipients[0]!.address).toBe(address);
    expect(await resolver(audienceDefinition)).toStrictEqual({
      eligibleSubscriberCount: 1,
    });
  });

  it("drops a confirmed subscriber from the audience once they unsubscribe", async () => {
    const { application, ledgerStore, sent } = harness();
    const audience = createCampaignBulkAudience({ siteId, store: ledgerStore });
    await application.requestSignup({
      submissionId: "3f6c2b3a-6f0f-4a19-9d2b-2f52f4a2a111",
      email: address,
      disclosure,
    });
    await application.deliverDueConfirmations({ leaseToken: "lease" });
    await application.confirmSignup({
      token: new URL(sent[0]!.confirmationUrl).searchParams.get("token")!,
    });

    const subscriber = (await ledgerStore.findByIdentityKey({
      siteId,
      identityKey: identityKeyFor(address),
    }))!;
    await ledgerStore.appendEvent({
      subscriber: { ...subscriber, state: "unsubscribed" },
      event: {
        id: "event-unsub" as never,
        siteId,
        subscriberId: subscriber.id,
        type: "unsubscribed",
        occurredAt: "2026-04-01T00:00:00.000Z",
        recordedAt: "2026-04-01T00:00:00.000Z",
        actor: { type: "provider", provider: "test", providerEventId: "u1" },
        evidence: null,
      },
    });

    expect(
      await audience.resolve({ audienceDefinition } as never),
    ).toStrictEqual([]);
  });
});

describe("agents see counts, never identities", () => {
  it("has no MCP tool that reads or exports subscribers", () => {
    const registry = createMcpToolRegistry({
      openWorkspace() {},
      requestPublication() {},
    } as unknown as McpReadApplication);
    const everyScope = [
      "foundry.initial",
      "foundry.content.draft",
      "foundry.design.draft",
      "foundry.campaign.draft",
      "foundry.campaign.test",
      "foundry.analytics.read",
      "foundry.publication.publish",
      "foundry.publication.schedule",
    ];
    const tools = registry.list({
      connectionId: "connection-boundary",
      actorId: "actor-boundary",
      clientId: "https://client.example/mcp.json",
      siteId,
      scopes: everyScope,
    });
    const surface = JSON.stringify(tools).toLowerCase();
    for (const forbidden of [
      "subscriber-identities",
      "subscriber-ledger.export",
      "listidentities",
      "exportledger",
      "newsletter_signup_requests",
      "subscriberemail",
    ]) {
      expect(surface).not.toContain(forbidden);
    }
    expect(
      tools.some(({ name }) => /subscriber|signup/iu.test(name)),
    ).toBe(false);
  });

  it("reports an eligible count that carries no address", async () => {
    const { application, ledgerStore, sent } = harness();
    await application.requestSignup({
      submissionId: "3f6c2b3a-6f0f-4a19-9d2b-2f52f4a2a111",
      email: address,
      disclosure,
    });
    await application.deliverDueConfirmations({ leaseToken: "lease" });
    await application.confirmSignup({
      token: new URL(sent[0]!.confirmationUrl).searchParams.get("token")!,
    });

    const resolver = createSubscriberLedgerAudienceResolver({
      siteId,
      store: ledgerStore,
    });
    const result = await resolver(audienceDefinition);
    expect(result).toStrictEqual({ eligibleSubscriberCount: 1 });
    expect(JSON.stringify(result)).not.toContain(address);
    expect(JSON.stringify(result)).not.toContain("@");
  });
});
