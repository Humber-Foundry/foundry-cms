import { describe, expect, it, vi } from "vitest";

import { referenceSiteDefinition } from "@foundry/site-definition";

import {
  ContentApprovalInvalidError,
  createContentActorId,
  createContentApprovalId,
  createContentPublicationId,
  createContentRevisionApplication,
  createContentWorkspaceId,
  createInMemoryContentRevisionStore,
  createInMemoryPublishedSiteRepository,
  createMcpPublicationApplication,
  createMcpReadApplication,
  createPublishedSiteBundle,
  createSiteApplication,
  mcpContentDraftScope,
  mcpDesignDraftScope,
  mcpInitialScope,
  mcpPublicationPublishScope,
  mcpPublicationScheduleScope,
  type ContentPublication,
  type McpConnectionGrant,
  type McpConnectionPrincipal,
  type McpPublicationAuditEvent,
  type McpReadAuditEvent,
} from "./index";

const now = "2026-07-29T20:00:00.000Z";
const workspaceId = createContentWorkspaceId(
  "workspace_mcp_publication",
);
const approvalId = createContentApprovalId(
  "approval_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
);
const publicationId = createContentPublicationId(
  "publish_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
);
const principal: McpConnectionPrincipal = {
  connectionId: "connection-publication-56",
  actorId: "agent-publication-56",
  clientId: "https://client.example/mcp.json",
  siteId: referenceSiteDefinition.site.id,
  scopes: [
    mcpInitialScope,
    mcpContentDraftScope,
    mcpPublicationPublishScope,
  ],
};
const context = {
  throwIfExpired() {},
  run: <Result>(operation: () => Promise<Result>) => operation(),
  finishDurably: <Result>(operation: () => Promise<Result>) =>
    operation(),
};

function publication(
  status: ContentPublication["status"],
): ContentPublication {
  return {
    id: publicationId,
    workspaceId,
    revision: 1,
    approvalId,
    fingerprint: "c".repeat(64),
    idempotencyKey: "durable-publication-key",
    requestedBy: createContentActorId("mcp-agent-publication-56"),
    contributors: [],
    expectedHead: "d".repeat(40),
    status,
    commitSha: null,
    deploymentId: null,
    deploymentRequestedAt: null,
    detail:
      status === "blocked" ? "publication_lease_lost" : null,
    leaseToken: null,
    leaseExpiresAt: null,
    requestedAt: now,
    updatedAt: now,
  };
}

/**
 * Minimal stand-in for the blog operations application the scheduling command
 * loads. Only the queries the command reaches before its artifact-kind check
 * are needed; `activateSchedule` must never be entered for a rejected kind.
 */
type BlogOperationsStub = Parameters<
  typeof createMcpPublicationApplication
>[0]["runtime"] extends { loadBlogOperations(...args: never): infer Loaded }
  ? Awaited<Loaded>
  : never;

async function fixture({
  connectionAt,
  seedEdits = [{
    path: "section_hero.title",
    value: "MCP approved publication",
  }],
  blogOperations = null,
}: {
  connectionAt?: (read: number) => McpConnectionGrant | null;
  seedEdits?: ReadonlyArray<{ path: string; value: string }>;
  blogOperations?: BlogOperationsStub | null;
} = {}) {
  const actorId = createContentActorId("mcp-agent-publication-56");
  const revisionApplication = createContentRevisionApplication({
    siteDefinition: referenceSiteDefinition,
    store: createInMemoryContentRevisionStore(),
    workspaceId,
    actorId,
    rendererVersion: "renderer-56",
    productionBase: "a".repeat(40),
    now: () => now,
  });
  await revisionApplication.commands.create({
    actorId,
    workspaceId,
    idempotencyKey: "create-mcp-publication-workspace",
  });
  await revisionApplication.commands.save({
    actorId,
    workspaceId,
    schemaVersion: referenceSiteDefinition.schemaVersion,
    baseRevision: 0,
    edits: seedEdits,
    idempotencyKey: "save-mcp-publication-workspace",
  });

  let connectionReads = 0;
  const readAudit: McpReadAuditEvent[] = [];
  const publicationAudit: McpPublicationAuditEvent[] = [];
  const read = createMcpReadApplication({
    site: createSiteApplication({
      siteId: referenceSiteDefinition.site.id,
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
        connectionReads += 1;
        return connectionAt === undefined
          ? { ...principal, status: "active" as const }
          : connectionAt(connectionReads);
      },
      async recordInvocation(event) {
        readAudit.push(event);
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
    createInvocationId: () => `invocation-${connectionReads + 1}`,
    now: () => now,
  });
  let storedPublication: ContentPublication | null = null;
  const publish = vi.fn(async (input: {
    assertCurrentAuthority?: () => Promise<boolean>;
  }) => {
    storedPublication = publication(
      await input.assertCurrentAuthority?.() === false
        ? "blocked"
        : "requested",
    );
    return storedPublication;
  });
  const application = createMcpPublicationApplication({
    base: read,
    runtime: {
      async loadRevision() {
        return revisionApplication;
      },
      async loadPublication() {
        return {
          commands: { publish },
          queries: {
            async findByIdempotency() {
              return storedPublication;
            },
          },
        } as unknown as Awaited<
          ReturnType<
            Parameters<
              typeof createMcpPublicationApplication
            >[0]["runtime"]["loadPublication"]
          >
        >;
      },
      async loadBlogOperations() {
        if (blogOperations === null) throw new Error("unused");
        return blogOperations;
      },
      async recordInvocation(event) {
        publicationAudit.push(event);
      },
    },
  });
  return {
    application,
    publish,
    publicationAudit,
    readAudit,
    revisionApplication,
    actorId,
  };
}

describe("MCP publication orchestration", () => {
  it("binds exact revision, approval, dynamic draft scope and joined audit evidence", async () => {
    const { application, publish, publicationAudit } = await fixture();

    const response = await application.requestPublication(
      principal,
      {
        workspaceId,
        revision: 1,
        approvalId,
        idempotencyKey:
          "11111111-1111-4111-8111-111111111111",
      },
      context,
    );

    expect(response).toMatchObject({
      result: {
        operationId: publicationId,
        state: "requested",
        replayed: false,
      },
    });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        revision: 1,
        approvalId,
        requestedBy: createContentActorId(
          "mcp-agent-publication-56",
        ),
        idempotencyKey: expect.stringMatching(/^mcp-[a-f0-9]{64}$/u),
        assertCurrentAuthority: expect.any(Function),
      }),
    );
    expect(publicationAudit).toEqual([
      expect.objectContaining({
        operation: "foundry.publication.request",
        scopesEvaluated: [
          mcpPublicationPublishScope,
          mcpContentDraftScope,
        ],
        workspaceId,
        revision: 1,
        approvalId,
        publicationId,
        scheduleId: null,
        replayed: false,
      }),
    ]);
  });

  it("passes a current-grant fence to the shared publisher", async () => {
    const { application, publish } = await fixture({
      connectionAt: (read) =>
        read === 1
          ? { ...principal, status: "active" as const }
          : null,
    });

    await expect(
      application.requestPublication(
        principal,
        {
          workspaceId,
          revision: 1,
          approvalId,
          idempotencyKey:
            "22222222-2222-4222-8222-222222222222",
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_SCOPE",
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it("intersects dynamic draft scopes with the current grant", async () => {
    const { application, publish } = await fixture({
      connectionAt: (read) =>
        read === 1
          ? { ...principal, status: "active" }
          : {
              ...principal,
              scopes: [mcpInitialScope, mcpPublicationPublishScope],
              status: "active",
            },
    });

    await expect(
      application.requestPublication(
        principal,
        {
          workspaceId,
          revision: 1,
          approvalId,
          idempotencyKey:
            "55555555-5555-4555-8555-555555555555",
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_SCOPE",
      requiredScopes: [
        mcpPublicationPublishScope,
        mcpContentDraftScope,
      ],
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it("rejects a stale revision before entering publication", async () => {
    const { application, publish, publicationAudit } = await fixture();

    await expect(
      application.requestPublication(
        principal,
        {
          workspaceId,
          revision: 0,
          approvalId,
          idempotencyKey:
            "33333333-3333-4333-8333-333333333333",
        },
        context,
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "STALE_REVISION",
      }),
    );
    expect(publish).not.toHaveBeenCalled();
    expect(publicationAudit).toEqual([
      expect.objectContaining({
        operation: "foundry.publication.request",
        outcome: "denied",
        reason: "STALE_REVISION",
      }),
    ]);
  });

  it("derives the design draft scope from the approved revision", async () => {
    const designPrincipal: McpConnectionPrincipal = {
      ...principal,
      scopes: [
        mcpInitialScope,
        mcpDesignDraftScope,
        mcpPublicationPublishScope,
      ],
    };
    // The approved revision changes only a Design-group field relative to
    // revision 0, so the required draft scope is design.draft. A fixed
    // content.draft fallback would demand a scope this connection has no
    // reason to hold and would reject a legitimate design publication.
    const { application, publish, publicationAudit } = await fixture({
      connectionAt: () => ({ ...designPrincipal, status: "active" }),
      seedEdits: [{ path: "design.colour.accent", value: "clay" }],
    });

    await application.requestPublication(
      designPrincipal,
      {
        workspaceId,
        revision: 1,
        approvalId,
        idempotencyKey: "66666666-6666-4666-8666-666666666666",
      },
      context,
    );

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publicationAudit).toEqual([
      expect.objectContaining({
        operation: "foundry.publication.request",
        outcome: "allowed",
        scopesEvaluated: [
          mcpPublicationPublishScope,
          mcpDesignDraftScope,
        ],
      }),
    ]);
    expect(
      publicationAudit[0]?.scopesEvaluated,
    ).not.toContain(mcpContentDraftScope);
  });

  it("forwards the caller's exact approval reference as evidence only", async () => {
    const { application, publish } = await fixture();

    await application.requestPublication(
      principal,
      {
        workspaceId,
        revision: 1,
        approvalId,
        idempotencyKey: "77777777-7777-4777-8777-777777777777",
      },
      context,
    );

    // The adapter passes the reference through unchanged and adds no approval
    // evidence of its own: no approved flag, no reviewer identity, and no
    // pre-approved fingerprint that could stand in for the human record.
    // `content-publication.test.ts` proves the shared command rejects an
    // approval bound to another workspace, revision or fingerprint.
    const [published] = publish.mock.calls[0] ?? [];
    expect(published).toMatchObject({ workspaceId, revision: 1, approvalId });
    expect(Object.keys(published ?? {})).toEqual(
      expect.not.arrayContaining([
        "approved",
        "approvedBy",
        "reviewer",
        "fingerprint",
        "previewConfirmed",
      ]),
    );
  });

  it("denies a substituted approval without entering publication", async () => {
    const { application, publish, publicationAudit } = await fixture();
    // The shared command is the only authority on whether the approval is
    // bound to this exact workspace, revision and fingerprint. When it
    // refuses, the adapter must surface an approval error and leave no
    // successful receipt behind.
    publish.mockImplementationOnce(() => {
      throw new ContentApprovalInvalidError("approval_not_found");
    });

    await expect(
      application.requestPublication(
        principal,
        {
          workspaceId,
          revision: 1,
          approvalId,
          idempotencyKey: "88888888-8888-4888-8888-888888888888",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(publicationAudit).toEqual([
      expect.objectContaining({
        operation: "foundry.publication.request",
        outcome: "denied",
        reason: "APPROVAL_REQUIRED",
      }),
    ]);
  });

  it("refuses to schedule an approval that is not a blog artifact", async () => {
    // A campaign or other non-blog artifact must not reach the scheduler:
    // "Campaign and email artifacts are rejected by the scheduling command."
    const activateSchedule = vi.fn();
    const schedulePrincipal: McpConnectionPrincipal = {
      ...principal,
      scopes: [
        mcpInitialScope,
        mcpContentDraftScope,
        mcpPublicationScheduleScope,
      ],
    };
    const { application, publicationAudit } = await fixture({
      connectionAt: () => ({ ...schedulePrincipal, status: "active" }),
      blogOperations: {
        commands: { activateSchedule },
        queries: {
          async findScheduleByWorkspaceRequest() {
            return null;
          },
          async getApproval() {
            return {
              id: approvalId,
              siteId: referenceSiteDefinition.site.id,
              workspaceId,
              contentRevision: 1,
              invalidatedAt: null,
            };
          },
          // The approved revision resolves to no schedulable blog post.
          async findSchedulablePostForApproval() {
            return null;
          },
        },
      } as unknown as BlogOperationsStub,
    });

    await expect(
      application.schedulePublication(
        schedulePrincipal,
        {
          workspaceId,
          revision: 1,
          approvalId,
          publishAt: "2026-11-01T08:00:00.000Z",
          reportingTimeZone: "America/Vancouver",
          idempotencyKey: "99999999-9999-4999-8999-999999999999",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "WRONG_ARTIFACT_KIND" });
    expect(activateSchedule).not.toHaveBeenCalled();
    expect(publicationAudit).toEqual([
      expect.objectContaining({
        operation: "foundry.publication.schedule",
        outcome: "denied",
        reason: "WRONG_ARTIFACT_KIND",
        scheduleId: null,
      }),
    ]);
  });

  it("replays a durable publication after a successor revision", async () => {
    const {
      application,
      publish,
      revisionApplication,
      actorId,
    } = await fixture();
    const input = {
      workspaceId,
      revision: 1,
      approvalId,
      idempotencyKey:
        "44444444-4444-4444-8444-444444444444",
    };
    await application.requestPublication(principal, input, context);
    await revisionApplication.commands.save({
      actorId,
      workspaceId,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 1,
      edits: [{
        path: "section_hero.title",
        value: "Successor revision",
      }],
      idempotencyKey: "save-successor-after-publication",
    });

    await expect(
      application.requestPublication(principal, input, context),
    ).resolves.toMatchObject({
      result: {
        operationId: publicationId,
        replayed: true,
      },
    });
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
