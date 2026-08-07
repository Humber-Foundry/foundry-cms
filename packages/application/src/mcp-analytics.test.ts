import { describe, expect, it } from "vitest";

import { referenceSiteDefinition } from "@foundry/site-definition";

import {
  AnalyticsRangeError,
  createInMemoryPublishedSiteRepository,
  createMcpAnalyticsApplication,
  createMcpReadApplication,
  createPublishedSiteBundle,
  createSiteApplication,
  mcpAnalyticsReadScope,
  mcpInitialScope,
  type McpAnalyticsRuntime,
  type McpConnectionGrant,
  type McpConnectionPrincipal,
  type McpReadAuditEvent,
} from "./index";

const now = "2026-08-06T18:00:00.000Z";
const siteId = referenceSiteDefinition.site.id;
const range = { fromLocalDate: "2026-07-10", toLocalDate: "2026-08-06" };

const context = {
  throwIfExpired() {},
  run: <Result>(operation: () => Promise<Result>) => operation(),
  finishDurably: <Result>(operation: () => Promise<Result>) => operation(),
};

function principal(scopes: ReadonlyArray<string>): McpConnectionPrincipal {
  return {
    connectionId: "connection-analytics-57",
    actorId: "agent-analytics-57",
    clientId: "https://client.example/mcp.json",
    siteId,
    scopes: [mcpInitialScope, ...scopes],
  };
}

function fixture(runtime: Partial<McpAnalyticsRuntime> = {}) {
  const audit: McpReadAuditEvent[] = [];
  let grant: McpConnectionGrant | null = null;
  const read = createMcpReadApplication({
    site: createSiteApplication({
      siteId,
      publishedSites: createInMemoryPublishedSiteRepository([
        createPublishedSiteBundle(referenceSiteDefinition),
      ]),
    }),
    siteMetadata: {
      canonicalUrl: "https://foundry.example",
      locale: "en-CA",
      timeZone: "America/Vancouver",
      async getLiveRelease() {
        return null;
      },
    },
    connections: {
      async findCurrentConnection() {
        return grant;
      },
      async recordInvocation(event) {
        audit.push(event);
      },
    },
    cursors: {
      async encode() {
        return "unused";
      },
      async decode() {
        throw new Error("unused");
      },
    },
    createInvocationId: () => "invocation-analytics",
    now: () => now,
  });
  const reads: Array<Record<string, unknown>> = [];
  const defaults: McpAnalyticsRuntime = {
    async read(input) {
      reads.push({ ...input });
      return {
        schemaVersion: "foundry.analytics.v1",
        siteId,
        range: { fromLocalDate: range.fromLocalDate },
        metrics: [],
        sources: [],
      };
    },
  };
  const application = createMcpAnalyticsApplication({
    base: read,
    runtime: { ...defaults, ...runtime },
  });
  return {
    application,
    audit,
    reads,
    activeGrant(scopes: ReadonlyArray<string>) {
      grant = { ...principal(scopes), status: "active" };
    },
  };
}

describe("mcp analytics", () => {
  it("returns a bounded view under the analytics.read scope", async () => {
    const harness = fixture();
    harness.activeGrant([mcpAnalyticsReadScope]);
    const success = (await harness.application.readAnalytics(
      principal([mcpAnalyticsReadScope]),
      { view: "overview", range, limit: null },
      context,
    )) as { result: Record<string, unknown> };
    expect(success.result).toMatchObject({ view: "overview" });
    expect(harness.reads).toHaveLength(1);
    expect(harness.reads[0]).toMatchObject({
      view: "overview",
      range,
      limit: null,
    });
    expect(harness.audit.at(-1)?.outcome).toBe("allowed");
  });

  it("refuses analytics without the analytics.read scope", async () => {
    const harness = fixture();
    harness.activeGrant([mcpInitialScope]);
    await expect(
      harness.application.readAnalytics(
        principal([mcpInitialScope]),
        { view: "overview", range, limit: null },
        context,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_SCOPE" });
  });

  it("maps an invalid range to a validation failure", async () => {
    const harness = fixture({
      async read() {
        throw new AnalyticsRangeError("range_inverted");
      },
    });
    harness.activeGrant([mcpAnalyticsReadScope]);
    await expect(
      harness.application.readAnalytics(
        principal([mcpAnalyticsReadScope]),
        { view: "overview", range, limit: null },
        context,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("fails closed when a projection guard trips", async () => {
    const harness = fixture({
      async read() {
        const error = new Error("aggregate payload rejected");
        error.name = "AnalyticsPrivacyViolationError";
        throw error;
      },
    });
    harness.activeGrant([mcpAnalyticsReadScope]);
    await expect(
      harness.application.readAnalytics(
        principal([mcpAnalyticsReadScope]),
        { view: "overview", range, limit: null },
        context,
      ),
    ).rejects.toMatchObject({ code: "TEMPORARILY_UNAVAILABLE" });
  });

  it("passes a bounded limit through for paginated views", async () => {
    const harness = fixture();
    harness.activeGrant([mcpAnalyticsReadScope]);
    await harness.application.readAnalytics(
      principal([mcpAnalyticsReadScope]),
      { view: "campaigns", range, limit: 10 },
      context,
    );
    expect(harness.reads[0]).toMatchObject({ view: "campaigns", limit: 10 });
  });
});
