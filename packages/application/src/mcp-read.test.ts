import { describe, expect, it } from "vitest";

import {
  createBlogPostId,
  createRichTextDocumentFromPlainText,
  createSiteId,
  referenceSiteDefinition,
  type SiteDefinition,
} from "@foundry/site-definition";

import {
  McpReadError,
  createInMemoryPublishedSiteRepository,
  createMcpReadApplication,
  createPublishedSiteBundle,
  createSiteApplication,
  type McpConnectionGrant,
  type McpReadAuditEvent,
} from "./index";

const siteId = referenceSiteDefinition.site.id;
const definitionWithPost = {
  ...referenceSiteDefinition,
  blog: {
    ...referenceSiteDefinition.blog,
    posts: [
      {
        id: createBlogPostId("11111111-1111-4111-8111-111111111111"),
        revision: 1,
        collectionState: "active",
        targetVisibility: "public",
        slug: "first-post",
        title: "First post",
        excerpt: "A first published post.",
        seo: {
          title: "First post",
          description: "A first published post.",
        },
        body: createRichTextDocumentFromPlainText("A first post."),
      },
    ],
  },
} satisfies SiteDefinition;
const principal = Object.freeze({
  connectionId: "connection-1",
  actorId: "mcp-actor-1",
  clientId: "https://client.example/metadata.json",
  siteId,
  scopes: ["site.read"] as const,
});

function activeConnection(
  overrides: Partial<McpConnectionGrant> = {},
): McpConnectionGrant {
  return Object.freeze({
    ...principal,
    status: "active",
    ...overrides,
  });
}

function fixture(overrides: {
  connection?: McpConnectionGrant | null;
  onFind?: () => void;
  resolveConnection?: () => McpConnectionGrant | null;
} = {}) {
  const audit: McpReadAuditEvent[] = [];
  const connection = overrides.connection ?? activeConnection();
  return {
    audit,
    application: createMcpReadApplication({
      site: createSiteApplication({
        siteId,
        publishedSites: createInMemoryPublishedSiteRepository([
          createPublishedSiteBundle(definitionWithPost),
        ]),
      }),
      siteMetadata: {
        canonicalUrl: "https://foundry.example",
        locale: "en-CA",
        timeZone: "America/Vancouver",
      },
      connections: {
        async findCurrentConnection() {
          overrides.onFind?.();
          return overrides.resolveConnection?.() ?? connection;
        },
        async recordInvocation(event) {
          audit.push(event);
        },
      },
      cursors: {
        async encode(binding) {
          return btoa(JSON.stringify(binding));
        },
        async decode(cursor) {
          return JSON.parse(atob(cursor));
        },
      },
      createInvocationId: () => "invocation-1",
      now: () => "2026-07-29T18:00:00.000Z",
    }),
  };
}

describe("site-scoped MCP read application", () => {
  it("returns typed site and schema data through the shared published-site boundary", async () => {
    const { application, audit } = fixture();

    await expect(application.getSite(principal)).resolves.toEqual({
      contractVersion: "foundry.mcp.v1",
      invocationId: "invocation-1",
      result: {
        siteId,
        displayName: referenceSiteDefinition.site.name,
        canonicalUrl: "https://foundry.example",
        locale: "en-CA",
        timeZone: "America/Vancouver",
        schemaVersion: referenceSiteDefinition.schemaVersion,
      },
      meta: {
        observedAt: "2026-07-29T18:00:00.000Z",
        replayed: false,
      },
    });
    await expect(application.getContentSchema(principal)).resolves.toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          schemaVersion: referenceSiteDefinition.schemaVersion,
          schema: expect.objectContaining({
            additionalProperties: false,
          }),
        }),
      }),
    );
    expect(audit).toEqual([
      expect.objectContaining({
        actorId: principal.actorId,
        connectionId: principal.connectionId,
        outcome: "allowed",
        operation: "foundry.site.get",
      }),
      expect.objectContaining({
        outcome: "allowed",
        operation: "foundry.schema.content.get",
      }),
    ]);
  });

  it("paginates published content with a cursor bound to the actor, site, and query", async () => {
    const { application } = fixture();

    const first = await application.listContent(principal, {
      kind: null,
      limit: 1,
      cursor: null,
    });
    expect(first.result.items).toEqual([
      expect.objectContaining({
        contentId: referenceSiteDefinition.home.id,
        kind: "page",
      }),
    ]);
    expect(first.result.nextCursor).toEqual(expect.any(String));

    const second = await application.listContent(principal, {
      kind: null,
      limit: 1,
      cursor: first.result.nextCursor,
    });
    expect(second.result.items).toEqual([
      expect.objectContaining({
        contentId: definitionWithPost.blog.posts[0]?.id,
        kind: "post",
      }),
    ]);
  });

  it("conceals cross-site reads and records a safe denial", async () => {
    const { application, audit } = fixture({
      connection: activeConnection({
        siteId: createSiteId("site_other"),
      }),
    });

    await expect(application.getSite(principal)).rejects.toEqual(
      expect.objectContaining({
        code: "AUTHENTICATION_REQUIRED",
      }),
    );
    expect(audit).toEqual([
      expect.objectContaining({
        outcome: "denied",
        reason: "AUTHENTICATION_REQUIRED",
        siteId,
      }),
    ]);
    expect(JSON.stringify(audit)).not.toContain("site_other");
  });

  it("reloads connection state on every command so revocation is immediate", async () => {
    let calls = 0;
    const connectionSequence = [
      activeConnection(),
      activeConnection({ status: "revoked" }),
    ];
    const { application } = fixture({
      onFind: () => {
        calls += 1;
      },
      resolveConnection: () => connectionSequence.shift() ?? null,
    });

    await expect(application.getSite(principal)).resolves.toBeDefined();
    await expect(application.getContentSchema(principal)).rejects.toBeInstanceOf(
      McpReadError,
    );
    expect(calls).toBe(2);
  });

  it.each([
    ["wildcard scope", activeConnection({ scopes: ["*"] })],
    ["human role confusion", activeConnection({ actorId: "membership-owner" })],
    [
      "client confusion",
      activeConnection({ clientId: "https://different.example/client.json" }),
    ],
  ])("fails closed on %s", async (_label, connection) => {
    const { application } = fixture({ connection });
    await expect(application.getSite(principal)).rejects.toEqual(
      expect.objectContaining({
        code: "AUTHENTICATION_REQUIRED",
      }),
    );
  });
});
