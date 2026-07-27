import { describe, expect, it, vi } from "vitest";

import {
  AccessIdentityError,
  AccessIdentityUnavailableError,
} from "./access-identity";
import { cloudflareAccessAssertionHeader } from "./access-authentication";
import { createDashboardIdentityBoundary } from "./dashboard-identity-availability";
import {
  readVerifiedDashboardIdentity,
  verifiedDashboardIdentityHeader,
} from "./verified-dashboard-identity";

const identity = {
  binding: {
    issuer: "https://foundry.cloudflareaccess.com",
    subject: "owner-subject",
  },
  email: "owner@example.com",
  nonce: "identity-nonce",
};

describe("dashboard identity availability boundary", () => {
  it("returns a non-cacheable 503 for a temporary identity-key outage", async () => {
    const next = vi.fn();
    const authenticate = vi
      .fn()
      .mockRejectedValue(new AccessIdentityUnavailableError());
    const boundary = createDashboardIdentityBoundary({
      next,
      authenticate,
    });
    const response = await boundary(
      new Request("https://example.com/dash"),
      {},
      {},
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("30");
    await expect(response.text()).resolves.toContain(
      "Dashboard temporarily unavailable",
    );
    expect(next).not.toHaveBeenCalled();
    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  it("passes one verified identity to the downstream dashboard request", async () => {
    const authenticate = vi.fn().mockResolvedValue(identity);
    const next = vi.fn(async (request: Request) => {
      expect(
        readVerifiedDashboardIdentity(request.headers),
      ).toEqual(identity);
      expect(
        request.headers.has(cloudflareAccessAssertionHeader),
      ).toBe(false);
      return new Response("dashboard");
    });
    const boundary = createDashboardIdentityBoundary({
      next,
      authenticate,
    });
    const request = new Request("https://example.com/dash", {
      headers: {
        [cloudflareAccessAssertionHeader]: "signed-assertion",
        [verifiedDashboardIdentityHeader]: encodeURIComponent(
          JSON.stringify({
            ...identity,
            email: "attacker@example.com",
          }),
        ),
      },
    });

    await expect(boundary(request, {}, {})).resolves.toHaveProperty(
      "status",
      200,
    );
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(
      authenticate.mock.calls[0]?.[0].requestHeaders.has(
        verifiedDashboardIdentityHeader,
      ),
    ).toBe(false);
    expect(
      authenticate.mock.calls[0]?.[0].requestHeaders.get(
        cloudflareAccessAssertionHeader,
      ),
    ).toBe("signed-assertion");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("returns 404 for invalid identity without invoking downstream", async () => {
    const next = vi.fn();
    const boundary = createDashboardIdentityBoundary({
      next,
      authenticate: vi
        .fn()
        .mockRejectedValue(new AccessIdentityError()),
    });

    const response = await boundary(
      new Request("https://example.com/dash"),
      {},
      {},
    );

    expect(response.status).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });

  it("strips an untrusted identity marker before unrelated routing", async () => {
    const authenticate = vi.fn();
    const next = vi.fn(async (request: Request) => {
      expect(
        request.headers.has(verifiedDashboardIdentityHeader),
      ).toBe(false);
      return new Response("public");
    });
    const boundary = createDashboardIdentityBoundary({
      next,
      authenticate,
    });

    const response = await boundary(
      new Request("https://example.com/rewritten-path", {
        headers: {
          [verifiedDashboardIdentityHeader]: encodeURIComponent(
            JSON.stringify(identity),
          ),
        },
      }),
      {},
      {},
    );

    expect(response.status).toBe(200);
    expect(authenticate).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
