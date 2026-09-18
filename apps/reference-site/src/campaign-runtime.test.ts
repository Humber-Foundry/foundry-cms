import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  loadHuman: vi.fn(),
  loadEnvironment: vi.fn(),
}));

vi.mock("./human-access-runtime", () => ({
  loadHumanAccessRequestContext: mocks.loadHuman,
}));
vi.mock("./human-access-environment", () => ({
  loadHumanAccessEnvironment: mocks.loadEnvironment,
}));

import {
  loadCampaignRequestContext,
  readCampaignDeliveryReadiness,
  resolveCampaignChannelConfiguration,
} from "./campaign-runtime";
import { campaignDeliverySettingNames } from "./campaign-delivery-readiness";


/**
 * A database binding that answers every read with nothing. Loading the request
 * context only builds the stores; it runs no query.
 */
const database = {
  prepare: () => ({
    bind: () => ({
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({}),
    }),
  }),
  batch: async () => [],
};

const identity = {
  binding: { issuer: "https://access.example", subject: "owner" },
  email: "owner@example.test",
  nonce: "nonce",
};

/**
 * Settings the newsletter needs that are not delivery secrets. The compliance
 * footer they build is stored on every campaign revision, so they are required
 * whether or not delivery is connected.
 */
const channelEnvironment = {
  FOUNDRY_CAMPAIGN_SENDER_IDENTITY_ID: "sender_primary",
  FOUNDRY_CAMPAIGN_COMPLIANCE_VERSION: "footer-v1",
  FOUNDRY_CAMPAIGN_LEGAL_NAME: "Example Publisher",
  FOUNDRY_CAMPAIGN_POSTAL_ADDRESS: "1 Example Street",
  FOUNDRY_CAMPAIGN_CONTACT_URL: "https://example.test/contact",
  FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL:
    "https://example.test/newsletter/unsubscribe",
};

const baseEnvironment = {
  FOUNDRY_DB: database,
  FOUNDRY_PRODUCTION_BASE: "a".repeat(40),
  ...channelEnvironment,
};

const deliveryEnvironment = {
  FOUNDRY_NEWSLETTER_DELIVERY_SECRET: "n".repeat(32),
  FOUNDRY_SUBSCRIBER_IDENTITY_SECRET: "s".repeat(32),
  FOUNDRY_BREVO_API_KEY: "example-api-key",
  FOUNDRY_CAMPAIGN_TEST_PROOF_KEY: "example-proof-key",
  FOUNDRY_BREVO_WEBHOOK_AUTH_TOKEN: "w".repeat(32),
  FOUNDRY_BREVO_ACCOUNT_SCOPE_FINGERPRINT: "a".repeat(64),
  FOUNDRY_BREVO_SENDERS_JSON: JSON.stringify({
    sender_primary: {
      id: 1,
      email: "news@example.test",
      name: "Example Publisher",
    },
  }),
  FOUNDRY_CAMPAIGN_TEST_RECIPIENTS_JSON: JSON.stringify({
    "membership-owner": "owner@example.test",
  }),
};

describe("campaign request context without delivery settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The runtime reads the durable branch whenever this is not development.
    vi.stubEnv("NODE_ENV", "production");
    mocks.loadHuman.mockResolvedValue({
      state: "authorized",
      identity,
      membership: { id: "membership-owner" },
      application: {
        queries: {
          requireCapability: async () => ({ id: "membership-owner" }),
          listActiveOwnerIdsForTestDelivery: async () => ["membership-owner"],
        },
      },
    });
    mocks.loadEnvironment.mockResolvedValue(baseEnvironment);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads without throwing when no delivery setting is installed", async () => {
    const context = await loadCampaignRequestContext(new Headers());
    expect(context.application).toBeDefined();
    expect(context.testDelivery).toBeDefined();
    expect(context.bulkDelivery).toBeDefined();
  });

  it("reports delivery as not configured and names every missing setting", async () => {
    const context = await loadCampaignRequestContext(new Headers());
    expect(context.delivery.state).toBe("not_configured");
    expect(context.delivery.missingSettings).toEqual([
      ...campaignDeliverySettingNames,
    ]);
    expect(context.delivery.setupGuide).toBe(
      "docs/operations/brevo-test-delivery-readiness.md",
    );
  });

  it("names settings only and never a value", async () => {
    const context = await loadCampaignRequestContext(new Headers());
    const joined = context.delivery.missingSettings.join(" ");
    for (const value of Object.values(deliveryEnvironment)) {
      expect(joined).not.toContain(value);
    }
    expect(JSON.stringify(context.delivery)).not.toContain("@example.test");
  });

  it("reports the provider as unavailable so a test cannot start", async () => {
    const context = await loadCampaignRequestContext(new Headers());
    await expect(context.readDeliveryHealth()).resolves.toEqual({
      state: "unavailable",
      credential: "unknown",
      senderIdentity: "unknown",
    });
  });

  it("still reports not configured when only one setting is absent", async () => {
    const { FOUNDRY_BREVO_API_KEY: _absent, ...rest } = deliveryEnvironment;
    mocks.loadEnvironment.mockResolvedValue({ ...baseEnvironment, ...rest });
    const context = await loadCampaignRequestContext(new Headers());
    expect(context.delivery.state).toBe("not_configured");
    expect(context.delivery.missingSettings).toEqual([
      "FOUNDRY_BREVO_API_KEY",
    ]);
  });

  it("still fails rather than continue when the database is absent", async () => {
    const { FOUNDRY_DB: _absent, ...rest } = baseEnvironment;
    mocks.loadEnvironment.mockResolvedValue(rest);
    await expect(
      loadCampaignRequestContext(new Headers()),
    ).rejects.toThrow("campaign_database_unavailable");
  });
});

describe("delivery readiness report", () => {
  it("returns the not-configured report without asking the provider", async () => {
    const readDeliveryHealth = vi.fn();
    const delivery = {
      state: "not_configured" as const,
      missingSettings: ["FOUNDRY_BREVO_API_KEY"],
      providerHealth: null,
      setupGuide: "docs/operations/brevo-test-delivery-readiness.md",
    };
    await expect(
      readCampaignDeliveryReadiness({ delivery, readDeliveryHealth }),
    ).resolves.toEqual(delivery);
    expect(readDeliveryHealth).not.toHaveBeenCalled();
  });

  it("adds the provider health when delivery is connected", async () => {
    const health = {
      state: "healthy" as const,
      credential: "verified" as const,
      senderIdentity: "verified" as const,
    };
    const readiness = await readCampaignDeliveryReadiness({
      delivery: {
        state: "connected",
        missingSettings: [],
        providerHealth: null,
        setupGuide: "docs/operations/brevo-test-delivery-readiness.md",
      },
      readDeliveryHealth: async () => health,
    });
    expect(readiness.providerHealth).toEqual(health);
    expect(readiness.state).toBe("connected");
  });

  it("reports the provider as unavailable when the check fails", async () => {
    const readiness = await readCampaignDeliveryReadiness({
      delivery: {
        state: "connected",
        missingSettings: [],
        providerHealth: null,
        setupGuide: "docs/operations/brevo-test-delivery-readiness.md",
      },
      readDeliveryHealth: async () => {
        throw new Error("network unreachable");
      },
    });
    expect(readiness.providerHealth).toEqual({
      state: "unavailable",
      credential: "unknown",
      senderIdentity: "unknown",
    });
  });
});

describe("compliance footer without delivery secrets", () => {
  it("builds the footer from the installation's own settings", () => {
    // The footer is stored on every campaign revision and is read by whoever
    // receives the email, so Foundry never stands in for it. It is built the
    // same way whether or not the delivery secrets are installed.
    const channel = resolveCampaignChannelConfiguration(channelEnvironment);
    expect(channel.senderIdentityId).toBe("sender_primary");
    expect(channel.complianceFooter.version).toBe("footer-v1");
    expect(channel.complianceFooter.content).toContain("Example Publisher");
    expect(channel.complianceFooter.content).toContain("1 Example Street");
    expect(channel.complianceFooter.unsubscribePlaceholder).toBe(
      "https://example.test/newsletter/unsubscribe" +
        "?token={{foundry.unsubscribe.token}}",
    );
  });

  it("refuses to build a footer the installation has not configured", () => {
    const { FOUNDRY_CAMPAIGN_LEGAL_NAME: _absent, ...rest } =
      channelEnvironment;
    expect(() => resolveCampaignChannelConfiguration(rest)).toThrow();
  });
});
