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
  notConfiguredComplianceVersion,
  readCampaignDeliveryReadiness,
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

/** Settings the newsletter needs that are not delivery settings. */
const baseEnvironment = {
  FOUNDRY_DB: database,
  FOUNDRY_PRODUCTION_BASE: "a".repeat(40),
};

const deliveryEnvironment = {
  FOUNDRY_CAMPAIGN_SENDER_IDENTITY_ID: "sender_primary",
  FOUNDRY_CAMPAIGN_COMPLIANCE_VERSION: "footer-v1",
  FOUNDRY_CAMPAIGN_LEGAL_NAME: "Example Publisher",
  FOUNDRY_CAMPAIGN_POSTAL_ADDRESS: "1 Example Street",
  FOUNDRY_CAMPAIGN_CONTACT_URL: "https://example.test/contact",
  FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL:
    "https://example.test/newsletter/unsubscribe",
  FOUNDRY_NEWSLETTER_DELIVERY_SECRET: "n".repeat(32),
  FOUNDRY_SUBSCRIBER_IDENTITY_SECRET: "s".repeat(32),
  FOUNDRY_BREVO_API_KEY: "example-api-key",
  FOUNDRY_CAMPAIGN_TEST_PROOF_KEY: "example-proof-key",
  FOUNDRY_BREVO_WEBHOOK_AUTH_TOKEN: "w".repeat(32),
  FOUNDRY_BREVO_ACCOUNT_SCOPE_FINGERPRINT: "a".repeat(64),
  FOUNDRY_BREVO_PROVISIONING_EVIDENCE_JSON: JSON.stringify({
    classification: "client_owned",
    evidenceId: "evidence-1",
    accountScopeFingerprint: "a".repeat(64),
    verifiedAt: "2026-01-01T00:00:00.000Z",
  }),
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
          requireCapability: async () => undefined,
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
    expect(context.delivery.connected).toBe(false);
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

  it("marks a campaign written now as not sendable", async () => {
    const context = await loadCampaignRequestContext(new Headers());
    // The compliance footer names the state rather than a legal entity that
    // this installation has not configured yet.
    expect(notConfiguredComplianceVersion).toBe("not-configured");
    expect(context.delivery.connected).toBe(false);
  });

  it("still reports not configured when only one setting is absent", async () => {
    const { FOUNDRY_BREVO_API_KEY: _absent, ...rest } = deliveryEnvironment;
    mocks.loadEnvironment.mockResolvedValue({ ...baseEnvironment, ...rest });
    const context = await loadCampaignRequestContext(new Headers());
    expect(context.delivery.connected).toBe(false);
    expect(context.delivery.missingSettings).toEqual([
      "FOUNDRY_BREVO_API_KEY",
    ]);
  });

  it("still fails rather than continue when the database is absent", async () => {
    mocks.loadEnvironment.mockResolvedValue({
      FOUNDRY_PRODUCTION_BASE: "a".repeat(40),
    });
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
      connected: false,
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
        connected: true,
        missingSettings: [],
        providerHealth: null,
        setupGuide: "docs/operations/brevo-test-delivery-readiness.md",
      },
      readDeliveryHealth: async () => health,
    });
    expect(readiness.providerHealth).toEqual(health);
    expect(readiness.connected).toBe(true);
  });

  it("reports the provider as unavailable when the check fails", async () => {
    const readiness = await readCampaignDeliveryReadiness({
      delivery: {
        state: "connected",
        connected: true,
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
