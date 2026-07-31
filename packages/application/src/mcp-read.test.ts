import { describe, expect, it, vi } from "vitest";

import {
  createBlogPostId,
  createRichTextDocumentFromPlainText,
  createSiteId,
  referenceSiteDefinition,
  type SiteDefinition,
} from "@foundry/site-definition";

import {
  ContentRevisionStaleError,
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
        async getLiveRelease() {
          return {
            gitSha: "a".repeat(40),
            releaseId: "release-1",
            observedAt: "2026-07-29T17:59:00.000Z",
          };
        },
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
        liveRelease: {
          gitSha: "a".repeat(40),
          releaseId: "release-1",
          observedAt: "2026-07-29T17:59:00.000Z",
        },
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

  it("requires site.read on both the presented principal and current connection", async () => {
    const { application } = fixture();
    await expect(
      application.getSite({ ...principal, scopes: [] }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "AUTHENTICATION_REQUIRED",
      }),
    );
  });

  it("audits every scope evaluated by a denial discovered during execution", async () => {
    const { application, audit } = fixture({
      connection: activeConnection({
        scopes: ["site.read", "content.draft", "design.draft"],
      }),
    });
    const mixedPrincipal = {
      ...principal,
      scopes: ["site.read", "design.draft"],
    };

    await expect(
      application.executeScoped({
        principal: mixedPrincipal,
        operation: "foundry.preview.prepare",
        auditInput: { workspaceId: "workspace_mixed" },
        requiredScopes: ["design.draft"],
        context: {
          throwIfExpired() {},
          run: (operation) => operation(),
          finishDurably: (operation) => operation(),
        },
        async run() {
          throw new McpReadError(
            "INSUFFICIENT_SCOPE",
            "The preview includes content and design changes.",
            { requiredScopes: ["content.draft", "design.draft"] },
          );
        },
      }),
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_SCOPE",
      requiredScopes: ["content.draft", "design.draft"],
    });
    expect(audit).toEqual([
      expect.objectContaining({
        outcome: "denied",
        scopesEvaluated: ["content.draft", "design.draft"],
      }),
    ]);
  });

  it("joins every dynamically evaluated scope into terminal mutation failures", async () => {
    const { application } = fixture({
      connection: activeConnection({
        scopes: ["site.read", "content.draft", "design.draft"],
      }),
    });
    const recordJoinedFailure = vi.fn(async () => {});

    await expect(
      application.executeScoped({
        principal: {
          ...principal,
          scopes: ["site.read", "content.draft", "design.draft"],
        },
        operation: "foundry.preview.prepare",
        auditInput: { idempotencyKey: "drift-key" },
        requiredScopes: ["design.draft"],
        context: {
          throwIfExpired() {},
          run: (operation) => operation(),
          finishDurably: (operation) => operation(),
        },
        joinedAudit: true,
        recordJoinedFailure,
        async run() {
          throw new McpReadError(
            "VALIDATION_FAILED",
            "The preview revision no longer matches the current deployment.",
            { requiredScopes: ["content.draft", "design.draft"] },
          );
        },
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      requiredScopes: [],
      auditRecorded: true,
    });
    expect(recordJoinedFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        scopesEvaluated: ["content.draft", "design.draft"],
      }),
      expect.objectContaining({
        code: "VALIDATION_FAILED",
      }),
    );
  });

  it("uses the joined mutation recorder when current scope is lost after admission", async () => {
    const { application, audit } = fixture({
      connection: activeConnection({
        scopes: ["site.read", "content.draft", "publication.publish"],
      }),
    });
    const recordJoinedFailure = vi.fn(async () => {});

    await expect(
      application.executeScoped({
        principal: {
          ...principal,
          scopes: ["site.read", "content.draft", "publication.publish"],
        },
        operation: "foundry.publication.request",
        auditInput: { idempotencyKey: "scope-loss-after-admission" },
        requiredScopes: ["publication.publish"],
        context: {
          throwIfExpired() {},
          run: (operation) => operation(),
          finishDurably: (operation) => operation(),
        },
        joinedAudit: true,
        recordJoinedFailure,
        async run() {
          throw new McpReadError(
            "INSUFFICIENT_SCOPE",
            "The current grant changed before the durable publication claim.",
            {
              requiredScopes: [
                "publication.publish",
                "content.draft",
              ],
            },
          );
        },
      }),
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_SCOPE",
      requiredScopes: ["publication.publish", "content.draft"],
      auditRecorded: true,
    });
    expect(recordJoinedFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "foundry.publication.request",
        scopesEvaluated: ["publication.publish", "content.draft"],
        // The row records this denial and its safe error code, rather than
        // inheriting the allowed outcome of the admission check it derives from.
        outcome: "denied",
        reason: "INSUFFICIENT_SCOPE",
      }),
      expect.objectContaining({ code: "INSUFFICIENT_SCOPE" }),
    );
    expect(audit).toEqual([]);
  });

  it("maps a stale stored revision to a replayable terminal mutation error", async () => {
    const { application } = fixture();
    const recordJoinedFailure = vi.fn(async () => {});

    await expect(
      application.executeScoped({
        principal,
        operation: "foundry.content.patch",
        auditInput: { idempotencyKey: "stale-key" },
        requiredScopes: ["site.read"],
        context: {
          throwIfExpired() {},
          run: (operation) => operation(),
          finishDurably: (operation) => operation(),
        },
        joinedAudit: true,
        recordJoinedFailure,
        async run() {
          throw new ContentRevisionStaleError(4);
        },
      }),
    ).rejects.toMatchObject({
      code: "STALE_REVISION",
      latestRevision: 4,
      replayed: false,
      auditRecorded: true,
    });
    expect(recordJoinedFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "foundry.content.patch",
      }),
      expect.objectContaining({
        code: "STALE_REVISION",
        latestRevision: 4,
      }),
    );
  });

  it("returns the authoritative joined failure when a terminal mutation loses an idempotency race", async () => {
    const { application, audit } = fixture();
    const recordJoinedFailure = vi.fn(async () =>
      new McpReadError(
        "IDEMPOTENCY_KEY_REUSED",
        "The idempotency key was already used for different input.",
        {
          observedAt: "2026-07-29T18:10:00.000Z",
          replayed: true,
          auditRecorded: true,
        },
      )
    );

    await expect(
      application.executeScoped({
        principal,
        operation: "foundry.content.patch",
        auditInput: { idempotencyKey: "raced-terminal-key" },
        requiredScopes: ["site.read"],
        context: {
          throwIfExpired() {},
          run: (operation) => operation(),
          finishDurably: (operation) => operation(),
        },
        joinedAudit: true,
        recordJoinedFailure,
        async run() {
          throw new McpReadError(
            "VALIDATION_FAILED",
            "The losing local failure must not escape.",
          );
        },
      }),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
      message:
        "The idempotency key was already used for different input.",
      observedAt: "2026-07-29T18:10:00.000Z",
      replayed: true,
      auditRecorded: true,
    });
    expect(audit).toEqual([]);
  });
});
