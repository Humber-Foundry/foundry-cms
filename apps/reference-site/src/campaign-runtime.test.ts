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
} from "./campaign-runtime";
import { resolveCampaignChannel } from "./campaign-channel-configuration";
import {
  campaignDeliverySettingNames,
  campaignSenderSettingNames,
} from "./campaign-delivery-readiness";
import { createCampaignId } from "@humber-foundry/application";


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
  FOUNDRY_CAMPAIGN_TEST_PROOF_KEY: "p".repeat(32),
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

  it("loads when delivery is installed but Git publishing is not", async () => {
    // Git publishing is configured separately. A send cannot commit its
    // artifact without it, but the Newsletter page must still load.
    mocks.loadEnvironment.mockResolvedValue({
      ...baseEnvironment,
      ...deliveryEnvironment,
    });
    const context = await loadCampaignRequestContext(new Headers());
    expect(context.delivery.state).toBe("connected");
    expect(context.application).toBeDefined();
  });

  it("still fails rather than continue when the database is absent", async () => {
    const { FOUNDRY_DB: _absent, ...rest } = baseEnvironment;
    mocks.loadEnvironment.mockResolvedValue(rest);
    await expect(
      loadCampaignRequestContext(new Headers()),
    ).rejects.toThrow("campaign_database_unavailable");
  });
});

const connectedSenderDetails = {
  state: "connected" as const,
  missingSettings: [],
  setupGuide: "docs/operations/brevo-test-delivery-readiness.md",
};

describe("delivery readiness report", () => {
  it("returns the not-configured report without asking the provider", async () => {
    const readDeliveryHealth = vi.fn();
    const delivery = {
      state: "not_configured" as const,
      missingSettings: ["FOUNDRY_BREVO_API_KEY" as const],
      providerHealth: null,
      setupGuide: "docs/operations/brevo-test-delivery-readiness.md",
    };
    await expect(
      readCampaignDeliveryReadiness({
        delivery,
        senderDetails: connectedSenderDetails,
        readDeliveryHealth,
      }),
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
      senderDetails: connectedSenderDetails,
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
      senderDetails: connectedSenderDetails,
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
    const channel = resolveCampaignChannel(channelEnvironment).channel;
    expect(channel.state).toBe("configured");
    if (channel.state !== "configured") throw new Error("unreachable");
    const { configuration } = channel;
    expect(configuration.senderIdentityId).toBe("sender_primary");
    expect(configuration.complianceFooter.version).toBe("footer-v1");
    expect(configuration.complianceFooter.content).toContain(
      "Example Publisher",
    );
    expect(configuration.complianceFooter.content).toContain(
      "1 Example Street",
    );
    expect(configuration.complianceFooter.unsubscribePlaceholder).toBe(
      "https://example.test/newsletter/unsubscribe" +
        "?token={{foundry.unsubscribe.token}}",
    );
  });

  it("reports a value rather than a placeholder footer when a setting is absent", () => {
    const { FOUNDRY_CAMPAIGN_LEGAL_NAME: _absent, ...rest } =
      channelEnvironment;
    const channel = resolveCampaignChannel(rest).channel;
    expect(channel.state).toBe("not_configured");
    if (channel.state !== "not_configured") throw new Error("unreachable");
    expect(channel.reason).toBe("campaign_sender_details_not_configured");
    expect(channel.missingSettings).toEqual([
      "FOUNDRY_CAMPAIGN_LEGAL_NAME",
    ]);
  });

  it("names an absent unsubscribe address like any other absent setting", () => {
    // An empty or malformed address is named, not raised as a bare URL error
    // from the address parser.
    const { FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL: _absent, ...rest } =
      channelEnvironment;
    for (const environment of [
      rest,
      { ...channelEnvironment, FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL: "not a url" },
    ]) {
      const channel = resolveCampaignChannel(environment).channel;
      expect(channel.state).toBe("not_configured");
      if (channel.state !== "not_configured") throw new Error("unreachable");
      expect(channel.missingSettings).toEqual([
        "FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL",
      ]);
    }
  });
});

describe("campaign request context without the sender details", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    // A new installation: the database is there, nothing else is.
    mocks.loadEnvironment.mockResolvedValue({
      FOUNDRY_DB: database,
      FOUNDRY_PRODUCTION_BASE: "a".repeat(40),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads rather than failing the page", async () => {
    const context = await loadCampaignRequestContext(new Headers());
    expect(context.application).toBeDefined();
    expect(context.testDelivery).toBeDefined();
    expect(context.bulkDelivery).toBeDefined();
  });

  it("reports the sender details under their own heading", async () => {
    const context = await loadCampaignRequestContext(new Headers());
    expect(context.senderDetails.state).toBe("not_configured");
    expect(context.senderDetails.missingSettings).toEqual([
      ...campaignSenderSettingNames,
    ]);
    expect(context.senderDetails.setupGuide).toBe(
      "docs/operations/brevo-test-delivery-readiness.md",
    );
    // The delivery secrets stay in their own report.
    expect(context.delivery.missingSettings).toEqual([
      ...campaignDeliverySettingNames,
    ]);
    for (const name of context.senderDetails.missingSettings) {
      expect(context.delivery.missingSettings).not.toContain(name);
    }
  });

  it("names settings only and never a value", async () => {
    const context = await loadCampaignRequestContext(new Headers());
    for (const name of context.senderDetails.missingSettings) {
      expect(name).toMatch(/^FOUNDRY_[A-Z0-9_]+$/u);
    }
  });

  it("still reports the settings as missing when only one is absent", async () => {
    const { FOUNDRY_CAMPAIGN_POSTAL_ADDRESS: _absent, ...rest } =
      channelEnvironment;
    mocks.loadEnvironment.mockResolvedValue({
      FOUNDRY_DB: database,
      FOUNDRY_PRODUCTION_BASE: "a".repeat(40),
      ...rest,
    });
    const context = await loadCampaignRequestContext(new Headers());
    expect(context.senderDetails.state).toBe("not_configured");
    expect(context.senderDetails.missingSettings).toEqual([
      "FOUNDRY_CAMPAIGN_POSTAL_ADDRESS",
    ]);
  });

  it("reports the sender details as connected once every setting is set", async () => {
    mocks.loadEnvironment.mockResolvedValue({
      FOUNDRY_DB: database,
      FOUNDRY_PRODUCTION_BASE: "a".repeat(40),
      ...channelEnvironment,
    });
    const context = await loadCampaignRequestContext(new Headers());
    expect(context.senderDetails.state).toBe("connected");
    expect(context.senderDetails.missingSettings).toEqual([]);
  });

  it("refuses every authorizing, scheduling and sending command with one reason", async () => {
    const context = await loadCampaignRequestContext(new Headers());
    const campaignId = createCampaignId(
      "00000000-0000-4000-8000-000000000183",
    );
    const requestId = "campaign-request-0000000000000183";
    const refusals = [
      () =>
        context.bulkDelivery.commands.authorize({
          actor: identity,
          requestId,
          campaignId,
          testExecutionId: "00000000-0000-4000-8000-000000000184",
        }),
      () =>
        context.bulkDelivery.commands.activateSchedule({
          actor: identity,
          requestId,
          campaignId,
          authorizationId: "00000000-0000-4000-8000-000000000185",
          resolvedTime: {
            localDateTime: "2030-01-01T00:00:00",
            ianaTimeZone: "UTC",
            utcOffsetChoice: "+00:00",
            executeAtUtc: "2030-01-01T00:00:00.000Z",
            timeZoneDatabaseVersion: "2026a",
          },
        }),
      () =>
        context.bulkDelivery.commands.sendNow({
          actor: identity,
          requestId,
          campaignId,
          authorizationId: "00000000-0000-4000-8000-000000000186",
        }),
      () =>
        context.bulkDelivery.commands.retrySend({
          actor: identity,
          requestId,
          campaignId,
          operationId: "00000000-0000-4000-8000-000000000187",
        }),
      () => context.bulkDelivery.scheduler.claimDue(),
      () =>
        context.bulkDelivery.scheduler.execute(
          "00000000-0000-4000-8000-000000000188",
        ),
      () => context.bulkDelivery.scheduler.reconcilePending(),
    ];
    for (const refusal of refusals) {
      await expect(
        (async () => refusal())(),
      ).rejects.toThrow("campaign_sender_details_not_configured");
    }
  });
});

describe("local development", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "development");
    mocks.loadHuman.mockResolvedValue({
      state: "authorized",
      identity,
      membership: { id: "membership-local-owner" },
      application: {
        queries: {
          requireCapability: async () => ({ id: "membership-local-owner" }),
          listActiveOwnerIdsForTestDelivery: async () => [],
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses a footer that announces itself and can never be sent", async () => {
    // Local development is the one place a footer is not built from an
    // installation's own settings. It must be impossible to mistake it for a
    // real legal name or postal address, and impossible to send.
    const context = await loadCampaignRequestContext(new Headers());
    expect(context.delivery.state).toBe("local_development");
    expect(context.senderDetails.state).toBe("local_development");
    // Every provider adapter is the fail-closed one, so nothing goes out.
    await expect(context.readDeliveryHealth()).resolves.toEqual({
      state: "unavailable",
      credential: "unknown",
      senderIdentity: "unknown",
    });
    // The settings themselves are never read in development, so no real
    // value can leak into the development footer.
    expect(mocks.loadEnvironment).not.toHaveBeenCalled();
  });
});
