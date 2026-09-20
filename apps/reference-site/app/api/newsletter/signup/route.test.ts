import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  loadEnvironment: vi.fn(),
  allow: vi.fn(),
  verifyTurnstile: vi.fn(),
  requestSignup: vi.fn(),
}));

vi.mock("../../../../src/newsletter-signup-runtime", async () => {
  const readiness = await import(
    "../../../../src/newsletter-signup-readiness"
  );
  return {
    loadNewsletterSignupEnvironment: mocks.loadEnvironment,
    allowNewsletterSignupAttempt: mocks.allow,
    loadNewsletterSignupApplication: async () => ({
      requestSignup: mocks.requestSignup,
    }),
    publicNewsletterSignupStatus: readiness.publicNewsletterSignupStatus,
  };
});
vi.mock("../../../../src/cloudflare-turnstile", () => ({
  createCloudflareTurnstileVerifier: () => ({ verify: mocks.verifyTurnstile }),
}));

import { GET, POST } from "./route";

const secret = "a-secret-value-long-enough-for-this-check";
const origin = "https://example.test";
const address = "reader@example.test";

const connected = Object.freeze({
  FOUNDRY_CANONICAL_ORIGIN: origin,
  FOUNDRY_NEWSLETTER_DELIVERY_SECRET: secret,
  FOUNDRY_SUBSCRIBER_IDENTITY_SECRET: secret,
  FOUNDRY_TURNSTILE_SITE_KEY: "0xSITEKEY",
  FOUNDRY_TURNSTILE_SECRET: "turnstile-secret",
  FOUNDRY_BREVO_API_KEY: "api-key",
  FOUNDRY_BREVO_SENDERS_JSON: JSON.stringify({
    primary: { id: 1, email: "news@example.test", name: "Studio" },
  }),
  FOUNDRY_CAMPAIGN_SENDER_IDENTITY_ID: "primary",
  FOUNDRY_CAMPAIGN_COMPLIANCE_VERSION: "footer-v1",
  FOUNDRY_CAMPAIGN_LEGAL_NAME: "Studio",
  FOUNDRY_CAMPAIGN_POSTAL_ADDRESS: "1 Street, Town",
  FOUNDRY_CAMPAIGN_CONTACT_URL: "https://example.test/contact",
  FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL: `${origin}/newsletter/unsubscribe`,
});

function body(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "1.0.0",
    submissionId: "3f6c2b3a-6f0f-4a19-9d2b-2f52f4a2a111",
    email: address,
    disclosureVersion: "newsletter-consent-1.0.0",
    collectionSurface: `${origin}/#section_newsletter`,
    turnstileToken: "turnstile-token",
    honeypot: "",
    startedAt: new Date(Date.now() - 10_000).toISOString(),
    ...overrides,
  };
}

function request(payload: unknown, headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/newsletter/signup`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "cf-connecting-ip": "203.0.113.4",
      ...headers,
    },
    body: JSON.stringify(payload),
  });
}

describe("public newsletter signup route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadEnvironment.mockResolvedValue(connected);
    mocks.allow.mockResolvedValue(true);
    mocks.verifyTurnstile.mockResolvedValue({
      success: true,
      hostname: "example.test",
      action: "newsletter-signup",
    });
    mocks.requestSignup.mockResolvedValue({ outcome: "check_your_inbox" });
  });

  it("tells the form whether signup works, and gives no setting names", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const value = await response.json();
    expect(value).toStrictEqual({
      available: true,
      turnstileSiteKey: "0xSITEKEY",
    });
    expect(JSON.stringify(value)).not.toContain("FOUNDRY_");
  });

  it("accepts a signup and says only to check the inbox", async () => {
    const response = await POST(request(body()));
    expect(response.status).toBe(202);
    expect(await response.json()).toStrictEqual({
      status: "check_your_inbox",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.requestSignup).toHaveBeenCalledWith({
      submissionId: "3f6c2b3a-6f0f-4a19-9d2b-2f52f4a2a111",
      email: address,
      disclosure: {
        version: "newsletter-consent-1.0.0",
        surface: `${origin}/#section_newsletter`,
      },
    });
  });

  it("never puts the address in the response", async () => {
    const response = await POST(request(body()));
    expect(await response.text()).not.toContain(address);
  });

  it("checks Turnstile on the server, using the submission id once", async () => {
    await POST(request(body()));
    expect(mocks.verifyTurnstile).toHaveBeenCalledWith({
      token: "turnstile-token",
      idempotencyKey: "3f6c2b3a-6f0f-4a19-9d2b-2f52f4a2a111",
    });
  });

  it("fails closed when the Turnstile check cannot run", async () => {
    mocks.verifyTurnstile.mockRejectedValue(new Error("turnstile_unavailable"));
    const response = await POST(request(body()));
    expect(response.status).toBe(503);
    expect(mocks.requestSignup).not.toHaveBeenCalled();
  });

  it("refuses a Turnstile token issued for another form", async () => {
    mocks.verifyTurnstile.mockResolvedValue({
      success: true,
      hostname: "example.test",
      action: "contact",
    });
    expect((await POST(request(body()))).status).toBe(400);
    expect(mocks.requestSignup).not.toHaveBeenCalled();
  });

  it("refuses a Turnstile token solved on another site", async () => {
    mocks.verifyTurnstile.mockResolvedValue({
      success: true,
      hostname: "attacker.test",
      action: "newsletter-signup",
    });
    expect((await POST(request(body()))).status).toBe(400);
  });

  it("holds the caller back when the rate limit is spent", async () => {
    mocks.allow.mockResolvedValue(false);
    const response = await POST(request(body()));
    expect(response.status).toBe(429);
    expect(mocks.verifyTurnstile).not.toHaveBeenCalled();
    expect(mocks.requestSignup).not.toHaveBeenCalled();
  });

  it("rate limits on the caller's address", async () => {
    await POST(request(body()));
    expect(mocks.allow).toHaveBeenCalledWith(connected, "203.0.113.4");
  });

  it("refuses a request from another origin", async () => {
    const response = await POST(
      request(body(), { origin: "https://attacker.test" }),
    );
    expect(response.status).toBe(400);
    expect(mocks.requestSignup).not.toHaveBeenCalled();
  });

  it("refuses a filled honeypot and a form filled too fast", async () => {
    expect((await POST(request(body({ honeypot: "bot" })))).status).toBe(400);
    expect(
      (await POST(request(body({ startedAt: new Date().toISOString() }))))
        .status,
    ).toBe(400);
    expect(mocks.requestSignup).not.toHaveBeenCalled();
  });

  it("refuses an envelope with an unexpected key or a wrong version", async () => {
    expect(
      (await POST(request({ ...body(), extra: "value" }))).status,
    ).toBe(400);
    expect(
      (await POST(request(body({ schemaVersion: "9.9.9" })))).status,
    ).toBe(400);
  });

  it("refuses a body that is not JSON", async () => {
    const response = await POST(
      new Request(`${origin}/api/newsletter/signup`, {
        method: "POST",
        headers: { "content-type": "text/plain", origin },
        body: "email=reader@example.test",
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.requestSignup).not.toHaveBeenCalled();
  });

  it("refuses a page that is not on this site as consent evidence", async () => {
    const response = await POST(
      request(body({ collectionSurface: "https://attacker.test/page" })),
    );
    expect(response.status).toBe(400);
    expect(mocks.requestSignup).not.toHaveBeenCalled();
  });

  it("says signup is not available, and reads no address, when a setting is missing", async () => {
    mocks.loadEnvironment.mockResolvedValue({
      ...connected,
      FOUNDRY_CAMPAIGN_LEGAL_NAME: "",
    });
    const response = await POST(request(body()));
    expect(response.status).toBe(503);
    expect(await response.json()).toStrictEqual({
      error: "signup_not_available",
    });
    expect(mocks.requestSignup).not.toHaveBeenCalled();
    expect(mocks.verifyTurnstile).not.toHaveBeenCalled();
  });

  it("tells the form no when a setting is missing", async () => {
    mocks.loadEnvironment.mockResolvedValue({
      ...connected,
      FOUNDRY_TURNSTILE_SITE_KEY: "",
    });
    expect(await (await GET()).json()).toStrictEqual({
      available: false,
      turnstileSiteKey: null,
    });
  });

  it("gives the same answer for a new address and one already on the list", async () => {
    const first = await POST(request(body()));
    const firstBody = await first.text();
    mocks.requestSignup.mockResolvedValue({ outcome: "check_your_inbox" });
    const second = await POST(
      request(body({ email: "already@example.test" })),
    );
    expect(second.status).toBe(first.status);
    expect(await second.text()).toBe(firstBody);
  });
});
