import { describe, expect, it } from "vitest";

import {
  contentSecurityPolicyDirectives as directives,
  dashboardPolicyShortfall,
  namesAHost,
} from "../../../scripts/lib/content-security-policy.mjs";

import {
  dashboardContentSecurityPolicy,
  dashboardContentSecurityPolicyHeaders,
} from "./dashboard-content-security-policy";

/**
 * The dashboard's Content Security Policy (#234, ADR-0049).
 *
 * Every dashboard document may run scripts and open frames from the site's
 * own origin only. A page component that tries to load a third-party embed
 * on an editing surface is refused by the browser before any request leaves
 * it. The exact preview and the public site are outside `/dash`, so they
 * keep the live Turnstile challenge.
 */
describe("dashboardContentSecurityPolicy", () => {
  it("allows scripts from the site's own origin only", () => {
    const policy = directives(
      dashboardContentSecurityPolicy({ development: false }),
    );
    expect(policy.get("script-src")).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it("allows frames from the site's own origin only", () => {
    const policy = directives(
      dashboardContentSecurityPolicy({ development: false }),
    );
    expect(policy.get("frame-src")).toEqual(["'self'"]);
  });

  it("refuses plug-in objects and embeds outright", () => {
    const policy = directives(
      dashboardContentSecurityPolicy({ development: false }),
    );
    expect(policy.get("object-src")).toEqual(["'none'"]);
  });

  it("names no host outside the site's own origin", () => {
    for (const development of [false, true]) {
      const policy = directives(dashboardContentSecurityPolicy({ development }));
      for (const values of policy.values()) {
        expect(values.some(namesAHost)).toBe(false);
      }
    }
  });

  it("is what the served-header checks expect, in both modes", () => {
    for (const development of [false, true]) {
      expect(
        dashboardPolicyShortfall(dashboardContentSecurityPolicy({ development })),
      ).toBeNull();
    }
    expect(dashboardPolicyShortfall(null)).toBe("no policy");
    expect(dashboardPolicyShortfall("frame-src 'self'")).toBe(
      "script-src lacks 'self'",
    );
    expect(
      dashboardPolicyShortfall(
        "script-src 'self' https://cdn.example; frame-src 'self'; object-src 'none'",
      ),
    ).toBe("script-src names a host");
  });

  it("adds eval only for the development server, which needs it", () => {
    const production = directives(
      dashboardContentSecurityPolicy({ development: false }),
    );
    const development = directives(
      dashboardContentSecurityPolicy({ development: true }),
    );
    expect(production.get("script-src")).not.toContain("'unsafe-eval'");
    expect(development.get("script-src")).toContain("'unsafe-eval'");
    expect(development.get("frame-src")).toEqual(production.get("frame-src"));
  });

  it("restricts nothing else, so the dashboard's own images, styles and requests are untouched", () => {
    const policy = directives(
      dashboardContentSecurityPolicy({ development: false }),
    );
    expect([...policy.keys()].sort()).toEqual([
      "frame-src",
      "object-src",
      "script-src",
    ]);
  });

  it("applies to every dashboard path and to nothing else", () => {
    const entries = dashboardContentSecurityPolicyHeaders({
      development: false,
    });
    expect(entries.map((entry) => entry.source)).toEqual(["/dash/:path*"]);
    for (const entry of entries) {
      expect(entry.headers).toEqual([
        {
          key: "Content-Security-Policy",
          value: dashboardContentSecurityPolicy({ development: false }),
        },
      ]);
    }
  });
});
