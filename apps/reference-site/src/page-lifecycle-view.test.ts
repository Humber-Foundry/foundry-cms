import { describe, expect, it } from "vitest";

import {
  createContentActorId,
  createContentRevisionApplication,
  createInMemoryContentRevisionStore,
  createInMemoryPublishedSiteRepository,
  createMcpDraftApplication,
  createMcpReadApplication,
  createPublishedSiteBundle,
  createSiteApplication,
  mcpContentDraftScope,
  type ContentRevisionApplication,
  type ContentWorkspaceId,
  type McpConnectionPrincipal,
  type McpExecutionContext,
} from "@humber-foundry/application";
import { referenceSiteDefinition } from "@humber-foundry/site-definition";

import { listPageActions } from "./page-lifecycle-view";

/**
 * A page a connected agent adds through MCP shows up in the Pages list.
 *
 * The dashboard has no way to add a page: pages come from an agent calling
 * `foundry.page.create` (ADR-0041). So the list is the only place the owner
 * ever sees an agent's new page, and this test drives the real MCP tool
 * against a real draft and then reads the list the Pages screen draws.
 */

const now = "2026-09-22T12:00:00.000Z";
const rendererVersion = "renderer-229";
const productionBase = "b".repeat(40);
const workspaceUrl = "/dash/pages?workspace=workspace_pages_list_test";

const principal: McpConnectionPrincipal = {
  connectionId: "connection-229",
  actorId: "agent-229",
  clientId: "https://client.example/mcp.json",
  siteId: referenceSiteDefinition.site.id,
  scopes: [mcpContentDraftScope],
};

const uninterrupted: McpExecutionContext = {
  throwIfExpired() {},
  run: (operation) => operation(),
  finishDurably: (operation) => operation(),
};

/**
 * One site, one draft workspace, and the MCP draft tools over them.
 *
 * Everything is held in memory. The draft never replays a stored result, so
 * every call in this test does its work for real.
 */
function fixture() {
  const workspaces = new Map<ContentWorkspaceId, ContentRevisionApplication>();
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
      async findCurrentConnection(input) {
        return input.connectionId === principal.connectionId &&
          input.siteId === principal.siteId
          ? { ...principal, status: "active" as const }
          : null;
      },
      async recordInvocation() {},
    },
    cursors: {
      async encode() {
        return "cursor";
      },
      async decode() {
        throw new Error("no_cursor_in_this_test");
      },
    },
    now: () => now,
  });

  function applicationFor(
    workspaceId: ContentWorkspaceId,
    actorId: ReturnType<typeof createContentActorId>,
  ) {
    const held = workspaces.get(workspaceId);
    if (held !== undefined) return held;
    const made = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createInMemoryContentRevisionStore(),
      workspaceId,
      actorId,
      rendererVersion,
      productionBase,
      now: () => now,
    });
    workspaces.set(workspaceId, made);
    return made;
  }

  const drafts = createMcpDraftApplication({
    base: read,
    runtime: {
      async replayMutation() {
        return null;
      },
      async recordMutationFailure(input) {
        return { error: input.error, observedAt: now, replayed: false };
      },
      async open(input) {
        const workspaceId = "workspace_pages_list_test" as ContentWorkspaceId;
        const application = applicationFor(workspaceId, input.actorId);
        await application.commands.create({
          actorId: input.actorId,
          workspaceId,
          idempotencyKey: input.idempotencyKey,
        });
        return application;
      },
      async load(input) {
        return applicationFor(input.workspaceId, input.actorId);
      },
      humanReviewUrl(previewId) {
        return `https://foundry.example/review/${previewId}`;
      },
      async mediaLibraryHoldsAsset() {
        return false;
      },
      async listMediaAssets() {
        return [];
      },
      async uploadMediaAsset() {
        throw new Error("no_upload_in_this_test");
      },
      async placeMediaOccurrence() {
        throw new Error("no_media_in_this_test");
      },
      cursors: {
        async encode() {
          return "cursor";
        },
        async decode() {
          throw new Error("no_cursor_in_this_test");
        },
      },
      async replayPreview() {
        return null;
      },
      async preparePreview() {
        throw new Error("no_preview_in_this_test");
      },
    },
  });

  return { drafts, workspaces };
}

function resultOf<Value>(answer: unknown): Value {
  return (answer as { result: Value }).result;
}

describe("the Pages list", () => {
  it("shows a page a connected agent made through foundry.page.create", async () => {
    const { drafts, workspaces } = fixture();
    const opened = resultOf<{ workspaceId: ContentWorkspaceId }>(
      await drafts.openWorkspace(
        principal,
        { expectedRevision: 0, idempotencyKey: "open-pages-list-test" },
        uninterrupted,
      ),
    );

    const created = resultOf<{ pageId: string }>(
      await drafts.createPage(
        principal,
        {
          workspaceId: opened.workspaceId,
          expectedRevision: 0,
          idempotencyKey: "create-pages-list-test",
          title: "What we offer",
          slug: "what-we-offer",
          startingLayout: "what_you_offer",
        },
        uninterrupted,
      ),
    );

    const draft = await workspaces
      .get(opened.workspaceId)!
      .queries.getCurrent();
    const rows = listPageActions(draft.definition, workspaceUrl);
    const row = rows.find((candidate) => candidate.id === created.pageId);

    expect(row).toMatchObject({
      title: "What we offer",
      path: "/what-we-offer",
      isHome: false,
      // Nothing is published with this page in it, so the row reads as a
      // page the site owner has not put on the site yet.
      publishedState: "not-published",
      canDelete: true,
      blockedBy: [],
    });
    // The home page is still first, and the agent's page is beside it.
    expect(rows.map(({ path }) => path)).toStrictEqual([
      "/",
      "/what-we-offer",
    ]);
  });
});
