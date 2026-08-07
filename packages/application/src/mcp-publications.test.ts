import { describe, expect, it, vi } from "vitest";

import {
  createSiteId,
  referenceSiteDefinition,
} from "@foundry/site-definition";

// Imported from its own module rather than the package barrel: the barrel
// re-exports this file's subject, so going through it can leave the hash
// helper uninitialised when only this test file is loaded.
import { sha256CanonicalJson } from "./deterministic-hash";

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
  type ContentPublicationClaim,
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
  // Mirrors the real command's ordering: the claim is observed first, carrying
  // the publication as it was claimed, and only then does the command reach the
  // lease and authority fences that decide the state it finally returns.
  const publish = vi.fn(async (input: {
    assertCurrentAuthority?: () => Promise<boolean>;
    observeClaim?: (claim: ContentPublicationClaim) => void;
  }) => {
    input.observeClaim?.({
      state: "claimed",
      publication: publication("requested"),
    });
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
    // Pinned so the scheduling window check is evaluated against a fixed
    // instant rather than the wall clock, which would eventually reorder
    // which validation a scheduling test reaches first.
    now: () => now,
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
    // The recorded hash is the hash of the receipt this invocation returned.
    // It is deliberately not expected to equal the linked row the store commits
    // inside the claim transaction, which hashes the outcome as admitted
    // because the terminal state does not exist yet. See ADR-0007.
    expect(publicationAudit[0]?.resultHash).toBe(
      await sha256CanonicalJson({
        operationId: publicationId,
        state: "requested",
        replayed: false,
      }),
    );
  });

  it("captures a sanitized actor approval publication trace without bearer passthrough", async () => {
    const { application, publish, publicationAudit } = await fixture();
    await application.requestPublication(
      principal,
      {
        workspaceId,
        revision: 1,
        approvalId,
        idempotencyKey: "12121212-1212-4212-8212-121212121212",
      },
      context,
    );
    const [publisherCommand] = publish.mock.calls[0] ?? [];
    expect(publisherCommand).toMatchObject({
      workspaceId,
      revision: 1,
      approvalId,
      requestedBy: createContentActorId("mcp-agent-publication-56"),
    });
    expect(publicationAudit[0]).toMatchObject({
      actorId: principal.actorId,
      connectionId: principal.connectionId,
      workspaceId,
      revision: 1,
      approvalId,
      publicationId,
    });
    const serialized = JSON.stringify({ publisherCommand, publicationAudit });
    expect(serialized).not.toMatch(
      /authorization|bearer|accessToken|refreshToken|providerPayload/iu,
    );
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

  it("generates approval and current-scope substitution cases before publication", async () => {
    const identityDimensions: ReadonlyArray<
      Partial<McpConnectionPrincipal>
    > = [
      { actorId: "agent-substituted" },
      { connectionId: "connection-substituted" },
      { clientId: "https://substituted.example/client.json" },
      { siteId: createSiteId("site_substituted") },
    ];
    const scopeStates = [
      {
        name: "valid",
        scopes: principal.scopes,
        requiredScopes: [] as ReadonlyArray<string>,
      },
      {
        name: "missing-publication",
        scopes: [mcpInitialScope, mcpContentDraftScope],
        requiredScopes: [mcpPublicationPublishScope],
      },
      {
        name: "missing-draft",
        scopes: [mcpInitialScope, mcpPublicationPublishScope],
        requiredScopes: [mcpContentDraftScope],
      },
      {
        name: "missing-publication-and-draft",
        scopes: [mcpInitialScope],
        requiredScopes: [mcpPublicationPublishScope],
      },
    ] as const;
    const deniedCases = scopeStates.flatMap((scopeState) =>
      Array.from(
        { length: 2 ** identityDimensions.length },
        (_, identityMask) => {
          if (identityMask === 0 && scopeState.name === "valid") {
            return null;
          }
          const identitySubstitutions = Object.assign(
            {},
            ...identityDimensions.filter(
              (_, index) => (identityMask & (1 << index)) !== 0,
            ),
          );
          return {
            name: `${identityMask}:${scopeState.name}`,
            principal: {
              ...principal,
              ...identitySubstitutions,
              scopes: scopeState.scopes,
            },
            expectedCode:
              identityMask === 0
                ? "INSUFFICIENT_SCOPE"
                : "AUTHENTICATION_REQUIRED",
            expectedRequiredScopes:
              identityMask === 0 ? scopeState.requiredScopes : [],
          };
        },
      ).filter((testCase) => testCase !== null),
    );
    expect(deniedCases).toHaveLength(63);
    expect(
      new Set(
        deniedCases.map(({ principal: deniedPrincipal }) =>
          JSON.stringify(deniedPrincipal),
        ),
      ).size,
    ).toBe(63);
    expect(deniedCases).toContainEqual(
      expect.objectContaining({
        name: "0:missing-publication-and-draft",
        principal: expect.objectContaining({ scopes: [mcpInitialScope] }),
      }),
    );
    for (const deniedCase of deniedCases) {
      const { application, publish } = await fixture();
      await expect(
        application.requestPublication(
          deniedCase.principal,
          {
            workspaceId,
            revision: 1,
            approvalId,
            idempotencyKey: "34343434-3434-4434-8434-343434343434",
          },
          context,
        ),
      ).rejects.toMatchObject({
        code: deniedCase.expectedCode,
        requiredScopes: deniedCase.expectedRequiredScopes,
      });
      expect(publish).not.toHaveBeenCalled();
    }
    for (const suffix of ["1", "2", "3", "4"]) {
      const { application, publish } = await fixture();
      publish.mockImplementationOnce(() => {
        throw new ContentApprovalInvalidError("approval_not_found");
      });
      await expect(
        application.requestPublication(
          principal,
          {
            workspaceId,
            revision: 1,
            approvalId: createContentApprovalId(
              `approval_${suffix.repeat(32)}`,
            ),
            idempotencyKey:
              `${suffix.repeat(8)}-${suffix.repeat(4)}-` +
              `4${suffix.repeat(3)}-8${suffix.repeat(3)}-${suffix.repeat(12)}`,
          },
          context,
        ),
      ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
      expect(publish).toHaveBeenCalledTimes(1);
    }
  });

  it("conceals foreign-site publication IDs before publisher or state mutation", async () => {
    const scheduleId = "schedule_0123abcd-4567-89ab-cdef-0123456789ab";
    const activateSchedule = vi.fn();
    const cancelSchedule = vi.fn();
    const blogOperations = {
      queries: {
        async findScheduleByWorkspaceRequest() {
          return null;
        },
      },
      commands: { activateSchedule, cancelSchedule },
    } as unknown as BlogOperationsStub;
    const foreign: McpConnectionPrincipal = {
      ...principal,
      connectionId: "connection-publication-foreign",
      actorId: "agent-publication-foreign",
      siteId: createSiteId("site_publication_foreign"),
      scopes: [...principal.scopes, mcpPublicationScheduleScope],
    };
    const { application, publish, publicationAudit } = await fixture({
      connectionAt: () => ({ ...foreign, status: "active" }),
      blogOperations,
    });
    await expect(
      application.requestPublication(
        foreign,
        {
          workspaceId,
          revision: 1,
          approvalId,
          idempotencyKey: "45454545-4545-4454-8454-454545454545",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "OBJECT_NOT_FOUND" });
    await expect(
      application.publicationStatus(
        foreign,
        { workspaceId, revision: 1, operationId: publicationId },
        context,
      ),
    ).rejects.toMatchObject({ code: "OBJECT_NOT_FOUND" });
    await expect(
      application.schedulePublication(
        foreign,
        {
          workspaceId,
          revision: 1,
          approvalId,
          publishAt: "2026-08-08T20:00:00.000Z",
          reportingTimeZone: "America/Vancouver",
          idempotencyKey: "56565656-5656-4656-8656-565656565656",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "OBJECT_NOT_FOUND" });
    await expect(
      application.publicationStatus(
        foreign,
        { workspaceId, revision: 1, operationId: scheduleId },
        context,
      ),
    ).rejects.toMatchObject({ code: "OBJECT_NOT_FOUND" });
    await expect(
      application.cancelPublicationSchedule(
        foreign,
        {
          workspaceId,
          revision: 1,
          scheduleId,
          idempotencyKey: "67676767-6767-4676-8676-676767676767",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "OBJECT_NOT_FOUND" });
    expect(publish).not.toHaveBeenCalled();
    expect(activateSchedule).not.toHaveBeenCalled();
    expect(cancelSchedule).not.toHaveBeenCalled();
    expect(publicationAudit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          siteId: foreign.siteId,
          outcome: "denied",
          reason: "OBJECT_NOT_FOUND",
        }),
      ]),
    );
    expect(JSON.stringify(publicationAudit)).not.toContain(
      "MCP approved publication",
    );
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

  it("reports a publication blocked by the fence inside the command", async () => {
    // The grant survives admission and the pre-flight check, then fails at the
    // command's own fence. The receipt must report the blocked state rather
    // than a success, and no external publication may be claimed as live.
    let reads = 0;
    const { application, publish, publicationAudit } = await fixture({
      connectionAt: () => {
        reads += 1;
        return reads <= 2 ? { ...principal, status: "active" } : null;
      },
    });

    const response = await application.requestPublication(
      principal,
      {
        workspaceId,
        revision: 1,
        approvalId,
        idempotencyKey: "ddddddd1-dddd-4ddd-8ddd-dddddddddddd",
      },
      context,
    );

    expect(publish).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({
      result: { operationId: publicationId, state: "blocked" },
    });
    expect(publicationAudit).toEqual([
      expect.objectContaining({ publicationId, replayed: false }),
    ]);
  });

  it("reports the state the publication command finally reached", async () => {
    // The claim is observed before the command commits to Git and verifies the
    // release, so the receipt must follow the command's return value. Reporting
    // the claimed publication instead would always say "requested".
    const { application, publish } = await fixture();
    publish.mockImplementationOnce(async (input) => {
      input.observeClaim?.({
        state: "claimed",
        publication: publication("requested"),
      });
      return publication("verified-live");
    });

    await expect(
      application.requestPublication(
        principal,
        {
          workspaceId,
          revision: 1,
          approvalId,
          idempotencyKey: "ccccccc1-cccc-4ccc-8ccc-cccccccccccc",
        },
        context,
      ),
    ).resolves.toMatchObject({
      result: {
        operationId: publicationId,
        state: "verified-live",
        replayed: false,
      },
    });
  });

  it("reports a store-detected durable replay from the claim", async () => {
    // A durable replay can be committed between the idempotency lookup and the
    // claim, and only the claim reports that race. The command returns the
    // pre-existing publication in that case, so what this pins is the
    // `replayed` flag the claim supplies — the receipt identity comes from the
    // command's return value either way.
    const { application, publish, publicationAudit } = await fixture();
    const replayedPublication = {
      ...publication("committed"),
      id: createContentPublicationId(
        "publish_cccccccccccccccccccccccccccccccc",
      ),
    };
    publish.mockImplementationOnce(async (input) => {
      // A replayed claim short-circuits the command, which returns the
      // pre-existing publication rather than the one it just built.
      input.observeClaim?.({
        state: "replayed",
        publication: replayedPublication,
      });
      return replayedPublication;
    });

    const response = await application.requestPublication(
      principal,
      {
        workspaceId,
        revision: 1,
        approvalId,
        idempotencyKey: "bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
      context,
    );

    expect(response).toMatchObject({
      result: {
        operationId: replayedPublication.id,
        state: "committed",
        replayed: true,
      },
    });
    expect(publicationAudit).toEqual([
      expect.objectContaining({
        publicationId: replayedPublication.id,
        replayed: true,
      }),
    ]);
  });

  it("returns the committed cancellation receipt on a repeated key", async () => {
    const schedule = {
      id: "schedule-56",
      postId: "post-56",
      workspaceId,
      contentRevision: 1,
      approvalId,
      state: "cancelled",
    };
    const cancelSchedule = vi.fn(async () => schedule);
    let committed: typeof schedule | null = null;
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
        commands: {
          async cancelSchedule(...args: ReadonlyArray<unknown>) {
            committed = await cancelSchedule(
              ...(args as Parameters<typeof cancelSchedule>),
            );
            return committed;
          },
        },
        queries: {
          async getSchedule() {
            return { ...schedule, state: "active" };
          },
          // Committed only once the cancellation receipt exists.
          async findScheduleCancellationByRequest() {
            return committed;
          },
        },
      } as unknown as BlogOperationsStub,
    });
    const input = {
      workspaceId,
      revision: 1,
      scheduleId: schedule.id,
      idempotencyKey: "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    };

    const first = await application.cancelPublicationSchedule(
      schedulePrincipal,
      input,
      context,
    );
    const replay = await application.cancelPublicationSchedule(
      schedulePrincipal,
      input,
      context,
    );

    expect(first).toMatchObject({
      result: { operationId: schedule.id, replayed: false },
    });
    // Repeating the same key and command returns that receipt with
    // replayed: true, and cancels nothing a second time.
    expect(replay).toMatchObject({
      result: { operationId: schedule.id, replayed: true },
    });
    expect(cancelSchedule).toHaveBeenCalledTimes(1);
    expect(publicationAudit.map(({ replayed }) => replayed)).toEqual([
      false,
      true,
    ]);
  });

  it("does not cancel a schedule after the grant is revoked", async () => {
    // The connection is admitted holding the schedule scope and loses its
    // live grant before the cancellation runs. Revocation must produce no
    // side effect, so the command is never entered.
    const cancelSchedule = vi.fn();
    const schedulePrincipal: McpConnectionPrincipal = {
      ...principal,
      scopes: [
        mcpInitialScope,
        mcpContentDraftScope,
        mcpPublicationScheduleScope,
      ],
    };
    let reads = 0;
    const { application, publicationAudit } = await fixture({
      connectionAt: () => {
        reads += 1;
        return reads <= 1
          ? { ...schedulePrincipal, status: "active" }
          : null;
      },
      blogOperations: {
        commands: { cancelSchedule },
        queries: {
          async getSchedule() {
            return {
              id: "schedule-56",
              postId: "post-56",
              workspaceId,
              contentRevision: 1,
              approvalId,
              state: "active",
            };
          },
          async findScheduleCancellationByRequest() {
            return null;
          },
        },
      } as unknown as BlogOperationsStub,
    });

    await expect(
      application.cancelPublicationSchedule(
        schedulePrincipal,
        {
          workspaceId,
          revision: 1,
          scheduleId: "schedule-56",
          idempotencyKey: "eeeeeee1-eeee-4eee-8eee-eeeeeeeeeeee",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_SCOPE" });
    expect(cancelSchedule).not.toHaveBeenCalled();
    expect(publicationAudit).toEqual([
      expect.objectContaining({
        operation: "foundry.publication.cancel",
        outcome: "denied",
        reason: "INSUFFICIENT_SCOPE",
      }),
    ]);
  });

  it("reads schedule status under the schedule scope alone", async () => {
    // The object named by the operation id decides the required scope, so a
    // connection granted only scheduling can read a schedule's status.
    const schedulePrincipal: McpConnectionPrincipal = {
      ...principal,
      scopes: [
        mcpInitialScope,
        mcpContentDraftScope,
        mcpPublicationScheduleScope,
      ],
    };
    const { application } = await fixture({
      connectionAt: () => ({ ...schedulePrincipal, status: "active" }),
      blogOperations: {
        commands: {},
        queries: {
          async getSchedule() {
            return {
              id: "schedule-56",
              postId: "post-56",
              workspaceId,
              contentRevision: 1,
              approvalId,
              state: "active",
            };
          },
        },
      } as unknown as BlogOperationsStub,
    });

    await expect(
      application.publicationStatus(
        schedulePrincipal,
        {
          workspaceId,
          revision: 1,
          operationId: "schedule-56",
        },
        context,
      ),
    ).resolves.toMatchObject({
      result: { operationId: "schedule-56", state: "active" },
    });
  });

  it("denies schedule status to a publish-only connection", async () => {
    // The contract assigns schedule status to publication.schedule. A
    // publish-only connection must not read it by virtue of holding the one
    // publication scope it does have.
    const { application } = await fixture();

    await expect(
      application.publicationStatus(
        principal,
        {
          workspaceId,
          revision: 1,
          operationId: "schedule-56",
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_SCOPE",
      requiredScopes: [mcpPublicationScheduleScope],
    });
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
