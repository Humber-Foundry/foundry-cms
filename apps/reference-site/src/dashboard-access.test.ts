import { describe, expect, it } from "vitest";

import { authorizeDashboard } from "./dashboard-access";

describe("dashboard access boundary", () => {
  it("allows the read-only dashboard during local development", () => {
    expect(authorizeDashboard({ runtime: "development" })).toEqual({
      allowed: true,
      reason: "local_development",
    });
  });

  it("fails closed outside development when auth is not configured", () => {
    expect(authorizeDashboard({ runtime: "production" })).toEqual({
      allowed: false,
      reason: "authentication_not_configured",
    });
  });
});
