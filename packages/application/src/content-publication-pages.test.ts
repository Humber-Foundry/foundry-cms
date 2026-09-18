import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  homePage,
  referenceSiteDefinition,
  type SiteDefinition,
  type SitePage,
} from "@humber-foundry/site-definition";

import { canonicalJson, sha256Text } from "./deterministic-hash";
import {
  createContentActorId,
  createContentRevisionApplication,
  createContentWorkspaceId,
  createInMemoryContentRevisionStore,
  type ContentRevision,
} from "./content-revisions";
import {
  ContentApprovalInvalidError,
  createContentApprovalFingerprint,
  createContentPublicationApplication,
  createContentPublicationId,
  createInMemoryContentPublicationStore,
  hashPublishedSiteDefinition,
  serializeContentPublicationArtifacts,
  type ContentPublicationDraftRestorer,
  type ContentPublicationRevisionRepository,
  type ContentPublishedRevisionReader,
  type ContentPublisher,
} from "./content-publication";
import { createHumanMembershipId } from "./human-access";

const workspaceId = createContentWorkspaceId("workspace_pages");
const editorId = createContentActorId("membership-editor");
const membershipId = createHumanMembershipId("membership-editor");
const productionCommit = "a".repeat(40);
const productionBase = `git:${productionCommit}@content:${"b".repeat(64)}`;

const aboutPageId = "page_about";

/** A second page, so a test can prove the home page is not the only one. */
function aboutPage(definition: SiteDefinition): SitePage {
  const home = homePage(definition);
  const hero = home.sections[0]!;
  if (hero.type !== "hero") throw new TypeError("expected_hero_fixture");
  const callToAction = home.sections.find(
    (section) => section.type === "callToAction",
  );
  if (callToAction === undefined || callToAction.type !== "callToAction") {
    throw new TypeError("expected_call_to_action_fixture");
  }
  return {
    id: aboutPageId,
    slug: "about",
    title: "About us",
    seo: home.seo,
    sections: [
      {
        ...hero,
        id: "section_about_hero",
        title: "About the studio",
        primaryAction: {
          id: "action_about_start",
          label: "Start a conversation",
          href: "#section_about_hero" as const,
        },
        ...(hero.secondaryAction === undefined
          ? {}
          : {
              secondaryAction: {
                ...hero.secondaryAction,
                id: "action_about_explore",
                href: "#section_about_hero" as const,
              },
            }),
      },
      {
        ...callToAction,
        id: "section_about_contact",
        action: {
          ...callToAction.action,
          id: "action_about_contact",
          href: "#section_about_contact" as const,
        },
      },
    ],
  };
}

function withAboutPage(definition: SiteDefinition): SiteDefinition {
  return { ...definition, pages: [...definition.pages, aboutPage(definition)] };
}

const twoPageDefinition = withAboutPage(referenceSiteDefinition);

async function revisionFixture(definition: SiteDefinition) {
  const application = createContentRevisionApplication({
    siteDefinition: definition,
    store: createInMemoryContentRevisionStore(),
    workspaceId,
    actorId: editorId,
    rendererVersion: "renderer-v1",
    productionBase,
    now: () => "2026-07-27T10:00:00.000Z",
  });
  const created = await application.commands.create({
    actorId: editorId,
    workspaceId,
    idempotencyKey: "create-pages-workspace-1",
  });
  return { application, created };
}

/** The same revision carrying a different definition, with matching inputs. */
async function revisionWith(
  base: ContentRevision,
  definition: SiteDefinition,
): Promise<ContentRevision> {
  return {
    ...base,
    definition,
    inputs: {
      ...base.inputs,
      contentHash: await hashPublishedSiteDefinition(definition),
    },
  };
}

function replaceAboutHeroVariant(definition: SiteDefinition): SiteDefinition {
  return {
    ...definition,
    pages: definition.pages.map((page) =>
      page.id !== aboutPageId
        ? page
        : {
            ...page,
            sections: page.sections.map((section) =>
              section.type !== "hero"
                ? section
                : { ...section, variant: "focused" as const },
            ),
          },
    ),
  };
}

describe("approval fingerprint over every page", () => {
  let base: ContentRevision;

  beforeEach(async () => {
    const fixture = await revisionFixture(twoPageDefinition);
    base = fixture.created;
  });

  async function designHashOf(definition: SiteDefinition) {
    const fingerprint = await createContentApprovalFingerprint(
      await revisionWith(base, definition),
      "channel-a",
    );
    return fingerprint;
  }

  it("changes the fingerprint when a design choice changes on a page that is not the home page", async () => {
    const [before, after] = await Promise.all([
      designHashOf(twoPageDefinition),
      designHashOf(replaceAboutHeroVariant(twoPageDefinition)),
    ]);

    expect(after.designHash).not.toBe(before.designHash);
    expect(after.value).not.toBe(before.value);
  });

  it("changes the fingerprint when a page is created", async () => {
    const [before, after] = await Promise.all([
      designHashOf(referenceSiteDefinition),
      designHashOf(twoPageDefinition),
    ]);

    expect(after.designHash).not.toBe(before.designHash);
    expect(after.value).not.toBe(before.value);
  });

  it("changes the fingerprint when a page is removed", async () => {
    const [before, after] = await Promise.all([
      designHashOf(twoPageDefinition),
      designHashOf({
        ...twoPageDefinition,
        pages: twoPageDefinition.pages.filter(
          ({ id }) => id !== aboutPageId,
        ),
      }),
    ]);

    expect(after.designHash).not.toBe(before.designHash);
    expect(after.value).not.toBe(before.value);
  });

  it("changes the fingerprint when a page is renamed or moved to a new address", async () => {
    const renamed = {
      ...twoPageDefinition,
      pages: twoPageDefinition.pages.map((page) =>
        page.id !== aboutPageId
          ? page
          : { ...page, title: "About the studio", slug: "studio" },
      ),
    };
    const [before, after] = await Promise.all([
      designHashOf(twoPageDefinition),
      designHashOf(renamed),
    ]);

    expect(after.designHash).not.toBe(before.designHash);
  });

  /**
   * The design projection changed shape once, at issue #160, so it could carry
   * every page. A definition with only the home page therefore gets a new
   * design hash, and every approval open at the upgrade becomes stale and must
   * be made again. ADR-0019 records that step. Changing this projection again
   * repeats that cost, so a later change needs its own decision record.
   */
  it("gives a home-page-only definition a new design hash after issue #160", async () => {
    const home = homePage(referenceSiteDefinition);
    const beforeIssue160 = {
      definitionVersion: referenceSiteDefinition.definitionVersion,
      design: referenceSiteDefinition.design,
      siteId: referenceSiteDefinition.site.id,
      navigation: referenceSiteDefinition.site.navigation.map(
        ({ id, href }) => ({ id, href }),
      ),
      pageId: home.id,
      sections: home.sections.map((section) =>
        section.type === "registered"
          ? { id: section.id, type: section.type, component: section.component }
          : { id: section.id, type: section.type, variant: section.variant },
      ),
    };
    const fingerprint = await designHashOf(referenceSiteDefinition);

    expect(fingerprint.designHash).not.toBe(
      await sha256Text(canonicalJson(beforeIssue160)),
    );
  });
});

describe("publication over every page", () => {
  let application: Awaited<ReturnType<typeof revisionFixture>>["application"];
  let publisher: ContentPublisher;
  let repository: ContentPublicationRevisionRepository;
  let clock: string[];

  beforeEach(async () => {
    const fixture = await revisionFixture(twoPageDefinition);
    application = fixture.application;
    await application.commands.save({
      actorId: editorId,
      workspaceId,
      schemaVersion: twoPageDefinition.schemaVersion,
      baseRevision: 0,
      edits: [
        { path: `${aboutPageId}.section_about_hero.title`, value: "About us" },
      ],
      idempotencyKey: "save-pages-workspace-0001",
    });
    clock = [
      "2026-07-27T10:01:00.000Z",
      "2026-07-27T10:02:00.000Z",
      "2026-07-27T10:03:00.000Z",
      "2026-07-27T10:04:00.000Z",
    ];
    publisher = {
      getChannelConfigurationHash: vi.fn().mockResolvedValue("channel-a"),
      getProductionHead: vi.fn().mockResolvedValue(productionCommit),
      isReleaseLive: vi.fn().mockResolvedValue(true),
      createCommit: vi.fn().mockResolvedValue({
        state: "committed",
        commitSha: "c".repeat(40),
      }),
      reconcileCommit: vi.fn().mockResolvedValue({ state: "not-found" }),
      retryReference: vi.fn().mockResolvedValue({
        state: "committed",
        commitSha: "c".repeat(40),
      }),
      getDeploymentStatus: vi.fn().mockResolvedValue("deployed"),
      retryDeployment: vi.fn().mockResolvedValue({
        state: "blocked",
        detail: "deployment_retry_claim_lost",
      }),
    };
    repository = {
      getRevision: async (_workspaceId, revision) =>
        application.queries.getRevision(revision),
      getCurrent: async () => application.queries.getCurrent(),
      isCurrent: async (revision) =>
        application.queries.isRevisionCurrent(revision),
      listContributors: async () => [editorId],
    };
  });

  function publicationApplication(
    extra: Partial<Parameters<typeof createContentPublicationApplication>[0]> = {},
  ) {
    return createContentPublicationApplication({
      store: createInMemoryContentPublicationStore(),
      revisions: repository,
      publisher,
      now: () => clock.shift() ?? "2026-07-27T10:05:00.000Z",
      ...extra,
    });
  }

  it("invalidates an approval after a later change on a page that is not the home page", async () => {
    const app = publicationApplication();
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    await application.commands.save({
      actorId: editorId,
      workspaceId,
      schemaVersion: twoPageDefinition.schemaVersion,
      baseRevision: 1,
      edits: [
        {
          path: `${aboutPageId}.section_about_hero.summary`,
          value: "A later edit the approver never saw.",
        },
      ],
      idempotencyKey: "save-pages-workspace-0002",
    });

    await expect(
      app.commands.publish({
        workspaceId,
        approvalId: approval.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-after-other-page-edit",
      }),
    ).rejects.toEqual(
      new ContentApprovalInvalidError("revision_not_current"),
    );
    // The same edit also breaks the fingerprint itself, so the approval stays
    // refused even where the revision number is not the guard that fires.
    const later = await application.queries.getCurrent();
    await expect(
      createContentApprovalFingerprint(later, "channel-a"),
    ).resolves.toEqual(
      expect.objectContaining({
        value: expect.not.stringMatching(approval.fingerprint.value),
      }),
    );
  });

  it("publishes and restores a two-page revision as the same artifacts", async () => {
    const current = await application.queries.getCurrent();
    const artifacts = serializeContentPublicationArtifacts(current.definition);
    const reader: ContentPublishedRevisionReader = {
      readPublishedArtifact: vi.fn(async ({ path }) =>
        artifacts.find((artifact) => artifact.path === path)?.bytes ?? null,
      ),
    };
    const restoredWorkspaceId = createContentWorkspaceId("workspace_restored");
    const restorer: ContentPublicationDraftRestorer = {
      restore: vi.fn().mockResolvedValue({
        workspaceId: restoredWorkspaceId,
        revision: 0,
        sourcePublicationId: createContentPublicationId(
          `publish_${"0".repeat(32)}`,
        ),
      }),
    };
    const app = publicationApplication({
      publishedRevisions: reader,
      draftRestorer: restorer,
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-two-page-revision",
    });
    await app.commands.refresh(publication.id);
    await app.commands.refresh(publication.id);
    vi.mocked(restorer.restore).mockResolvedValue({
      workspaceId: restoredWorkspaceId,
      revision: 0,
      sourcePublicationId: publication.id,
    });

    await app.commands.restore({
      sourcePublicationId: publication.id,
      actorId: editorId,
      workspaceId: restoredWorkspaceId,
      idempotencyKey: "restore-two-page-revision",
    });

    // Every page reached Git, and reading them back gives the same definition
    // and therefore the same artifacts.
    expect(
      artifacts.some(({ path }) =>
        path.startsWith(`content/rich-text/${aboutPageId}/`),
      ),
    ).toBe(true);
    expect(reader.readPublishedArtifact).toHaveBeenCalledTimes(
      artifacts.length,
    );
    expect(vi.mocked(restorer.restore).mock.calls[0]![0]!.definition).toEqual(
      current.definition,
    );
    expect(
      serializeContentPublicationArtifacts(
        vi.mocked(restorer.restore).mock.calls[0]![0]!.definition,
      ),
    ).toEqual(artifacts);
  });
});
