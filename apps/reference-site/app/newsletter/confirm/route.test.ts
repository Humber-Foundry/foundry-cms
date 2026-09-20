import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  NewsletterConfirmationExpiredError,
  NewsletterConfirmationLinkInvalidError,
} from "@humber-foundry/application";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ confirm: vi.fn() }));

vi.mock("../../../src/newsletter-signup-runtime", () => ({
  loadNewsletterSignupApplication: async () => ({
    confirmSignup: mocks.confirm,
  }),
}));

import { GET, POST } from "./route";

const origin = "https://example.test";

function post(bodyText: string) {
  return new Request(`${origin}/newsletter/confirm`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: bodyText,
  });
}

describe("newsletter confirmation page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.confirm.mockResolvedValue({ outcome: "confirmed" });
  });

  it("shows a button and confirms nothing on its own", async () => {
    const response = await GET(
      new Request(`${origin}/newsletter/confirm?token=abc`),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('method="post"');
    expect(text).toContain("Confirm signup");
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("works without JavaScript", async () => {
    const text = await (
      await GET(new Request(`${origin}/newsletter/confirm?token=abc`))
    ).text();
    expect(text).not.toContain("<script");
    expect(text).toContain("<form");
  });

  it("confirms the signup when the person presses the button", async () => {
    const response = await POST(post("token=abc"));
    expect(response.status).toBe(200);
    expect(mocks.confirm).toHaveBeenCalledWith({ token: "abc" });
    expect(await response.text()).toContain("You are on the list");
  });

  it("says the link is no longer valid rather than why", async () => {
    mocks.confirm.mockRejectedValue(new NewsletterConfirmationExpiredError());
    const response = await POST(post("token=abc"));
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("no longer valid");
    expect(text).not.toContain("expired_");
    expect(text).not.toContain("newsletter_confirmation");
  });

  it("says the same thing for a token this site did not sign", async () => {
    mocks.confirm.mockRejectedValue(
      new NewsletterConfirmationLinkInvalidError(),
    );
    const invalid = await POST(post("token=forged"));
    mocks.confirm.mockRejectedValue(new NewsletterConfirmationExpiredError());
    const expired = await POST(post("token=abc"));
    expect(invalid.status).toBe(expired.status);
    expect(await invalid.text()).toBe(await expired.text());
  });

  it("asks for a link when there is none", async () => {
    expect(
      (await GET(new Request(`${origin}/newsletter/confirm`))).status,
    ).toBe(400);
    expect((await POST(post("token="))).status).toBe(400);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("escapes the token it puts back in the page", async () => {
    const response = await GET(
      new Request(
        `${origin}/newsletter/confirm?token=${encodeURIComponent('a"><script>x</script>')}`,
      ),
    );
    const text = await response.text();
    expect(text).not.toContain("<script>x</script>");
    expect(text).toContain("&quot;");
  });

  it("never puts an address in the page or lets it be cached", async () => {
    const response = await POST(post("token=abc"));
    expect(await response.text()).not.toContain("@");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("does not blame the link for a fault in this code", async () => {
    // A bare TypeError is a programming fault. Reporting it as a bad link
    // would hide the fault and mislead the person who followed a good one.
    mocks.confirm.mockRejectedValue(new TypeError("cannot read property"));
    const response = await POST(post("token=abc"));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("no longer valid");
  });

  it("asks the person to try again when the site cannot answer", async () => {
    mocks.confirm.mockRejectedValue(new Error("database_unavailable"));
    const response = await POST(post("token=abc"));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("database_unavailable");
  });
});
