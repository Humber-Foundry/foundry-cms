import { describe, expect, it } from "vitest";

import {
  findPageById,
  homePage,
  isMintedPageId,
  referenceSiteDefinition,
} from "@humber-foundry/site-definition";

import {
  ContentPageOperationError,
  ContentRevisionConflictError,
  ContentRevisionValidationError,
  ContentWorkspaceAccessError,
  createContentActorId,
  createContentRevisionApplication,
  createContentWorkspaceId,
  createInMemoryContentRevisionStore,
} from "./content-revisions";

const actorId = createContentActorId("membership-editor");
const outsiderActorId = createContentActorId("membership-outsider");
const workspaceId = createContentWorkspaceId("workspace_pages");

const commandInputs = {
  actorId,
  workspaceId,
  schemaVersion: "1.7.0",
} as const;

/** A fresh application with its draft opened at revision 0. */
async function openDraft() {
  const application = createContentRevisionApplication({
    siteDefinition: referenceSiteDefinition,
    store: createInMemoryContentRevisionStore({}),
    workspaceId,
    actorId,
    rendererVersion: "renderer-commit-a",
    productionBase: "published:site_foundry_reference@1.1.0",
  });
  await application.commands.create({
    actorId,
    workspaceId,
    idempotencyKey: "open-the-draft-0000001",
  });
  return application;
}

function createPage(
  application: Awaited<ReturnType<typeof openDraft>>,
  input: Partial<
    Parameters<(typeof application)["commands"]["createPage"]>[0]
  > = {},
) {
  return application.commands.createPage({
    ...commandInputs,
    baseRevision: 0,
    idempotencyKey: "create-about-page-000001",
    title: "About us",
    slug: "about-us",
    startingLayout: "blank",
    ...input,
  });
}

async function refusal(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof ContentRevisionValidationError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected_a_refusal");
}

describe("createPage", () => {
  it("adds the page and answers with its minted id", async () => {
    const application = await openDraft();
    const result = await createPage(application);
    expect(result.replayed).toBe(false);
    expect(result.revision.revision).toBe(1);
    expect(isMintedPageId(result.pageId)).toBe(true);
    expect(result.pageId).not.toBe("home");
    const page = findPageById(result.revision.definition, result.pageId)!;
    expect(page.title).toBe("About us");
    expect(page.slug).toBe("about-us");
    expect(result.revision.definition.pages).toHaveLength(2);
  });

  it("builds the page from the starting point that was chosen", async () => {
    const application = await openDraft();
    const result = await createPage(application, {
      startingLayout: "what_you_offer",
    });
    const page = findPageById(result.revision.definition, result.pageId)!;
    expect(page.sections.map(({ type }) => type)).toStrictEqual([
      "hero",
      "services",
      "callToAction",
    ]);
  });

  it("makes no second page when the same request is sent twice", async () => {
    const application = await openDraft();
    const first = await createPage(application);
    const second = await createPage(application);
    expect(second.replayed).toBe(true);
    expect(second.pageId).toBe(first.pageId);
    expect(second.revision.revision).toBe(first.revision.revision);
    expect(second.revision.definition.pages).toHaveLength(2);
  });

  it("mints a different id for a different request", async () => {
    const application = await openDraft();
    const first = await createPage(application);
    const second = await createPage(application, {
      baseRevision: 1,
      idempotencyKey: "create-contact-page-00001",
      title: "Contact",
      slug: "contact",
    });
    expect(second.pageId).not.toBe(first.pageId);
    expect(second.revision.definition.pages).toHaveLength(3);
  });

  it("refuses a request that read an older revision", async () => {
    const application = await openDraft();
    await createPage(application);
    await expect(
      createPage(application, {
        idempotencyKey: "create-contact-page-00001",
        slug: "contact",
      }),
    ).rejects.toBeInstanceOf(ContentRevisionConflictError);
  });

  it("refuses someone who is not this draft's editor", async () => {
    const application = await openDraft();
    await expect(
      createPage(application, { actorId: outsiderActorId }),
    ).rejects.toBeInstanceOf(ContentWorkspaceAccessError);
  });

  it("refuses a request with no usable idempotency key", async () => {
    const application = await openDraft();
    const error = await refusal(() =>
      createPage(application, { idempotencyKey: "short" }),
    );
    expect(error.fields.idempotencyKey).toBe(
      "Use a 16–128 character idempotency key.",
    );
  });

  it("refuses a web address the site already serves itself", async () => {
    const application = await openDraft();
    const error = await refusal(() => createPage(application, { slug: "blog" }));
    expect(error).toBeInstanceOf(ContentPageOperationError);
    expect((error as ContentPageOperationError).code).toBe("page_slug_refused");
    expect(error.fields.slug).toBe(
      "The site already uses /blog for something else. Choose another web address.",
    );
  });

  it("refuses a web address another page already uses", async () => {
    const application = await openDraft();
    const created = await createPage(application);
    const error = await refusal(() =>
      createPage(application, {
        baseRevision: created.revision.revision,
        idempotencyKey: "create-second-about-0001",
      }),
    );
    expect(error.fields.slug).toBe("Another page already sits at /about-us.");
  });

  it("refuses to put a new page at the top of the site", async () => {
    const application = await openDraft();
    const error = await refusal(() => createPage(application, { slug: "" }));
    expect(error.fields.slug).toBe(
      "Only the home page can sit at the top of the site. Give this page a web address.",
    );
  });

  it("refuses a blank name and an unknown starting point", async () => {
    const application = await openDraft();
    expect(
      (await refusal(() => createPage(application, { title: "  " }))).fields
        .title,
    ).toBe("Give this page a name.");
    expect(
      (
        await refusal(() =>
          createPage(application, { startingLayout: "nothing" }),
        )
      ).fields.startingLayout,
    ).toBe("Choose one of the starting points offered.");
  });
});

describe("renamePage", () => {
  async function draftWithPage() {
    const application = await openDraft();
    const created = await createPage(application);
    return { application, created };
  }

  it("changes the page name and the web address together", async () => {
    const { application, created } = await draftWithPage();
    const result = await application.commands.renamePage({
      ...commandInputs,
      baseRevision: created.revision.revision,
      idempotencyKey: "rename-about-page-000001",
      pageId: created.pageId,
      title: "Our story",
      slug: "our-story",
    });
    const page = findPageById(result.revision.definition, created.pageId)!;
    expect(page.title).toBe("Our story");
    expect(page.slug).toBe("our-story");
    expect(result.pageId).toBe(created.pageId);
    // The page id never changes, so nothing that names it has to move.
    expect(page.id).toBe(created.pageId);
  });

  it("refuses to move the home page away from the top of the site", async () => {
    const { application, created } = await draftWithPage();
    const error = await refusal(() =>
      application.commands.renamePage({
        ...commandInputs,
        baseRevision: created.revision.revision,
        idempotencyKey: "rename-the-home-page-001",
        pageId: homePage(referenceSiteDefinition).id,
        title: "Front",
        slug: "front",
      }),
    );
    expect(error.fields.slug).toBe(
      "The home page always sits at the top of the site, so its web address cannot change.",
    );
  });

  it("refuses a web address another page already uses", async () => {
    const { application, created } = await draftWithPage();
    const second = await application.commands.createPage({
      ...commandInputs,
      baseRevision: created.revision.revision,
      idempotencyKey: "create-contact-page-00001",
      title: "Contact",
      slug: "contact",
      startingLayout: "blank",
    });
    const error = await refusal(() =>
      application.commands.renamePage({
        ...commandInputs,
        baseRevision: second.revision.revision,
        idempotencyKey: "rename-contact-page-0001",
        pageId: second.pageId,
        title: "Contact",
        slug: "about-us",
      }),
    );
    expect(error.fields.slug).toBe("Another page already sits at /about-us.");
  });

  it("asks for a name when the name is blank", async () => {
    const { application, created } = await draftWithPage();
    const error = await refusal(() =>
      application.commands.renamePage({
        ...commandInputs,
        baseRevision: created.revision.revision,
        idempotencyKey: "rename-about-page-000001",
        pageId: created.pageId,
        title: "   ",
        slug: "about-us",
      }),
    );
    expect(error.fields.title).toBe("Enter at least one visible character.");
  });

  it("refuses a page that is not in the draft", async () => {
    const { application, created } = await draftWithPage();
    const error = await refusal(() =>
      application.commands.renamePage({
        ...commandInputs,
        baseRevision: created.revision.revision,
        idempotencyKey: "rename-missing-page-0001",
        pageId: "page_ffffffffffffffffffff",
        title: "Gone",
        slug: "gone",
      }),
    );
    expect((error as ContentPageOperationError).code).toBe("page_not_found");
  });
});

describe("duplicatePage", () => {
  it("copies the page with fresh section ids and no shared field path", async () => {
    const application = await openDraft();
    const created = await createPage(application, {
      startingLayout: "what_you_offer",
    });
    const copied = await application.commands.duplicatePage({
      ...commandInputs,
      baseRevision: created.revision.revision,
      idempotencyKey: "duplicate-about-page-001",
      pageId: created.pageId,
      title: "About us copy",
      slug: "about-us-copy",
    });
    const definition = copied.revision.definition;
    const original = findPageById(definition, created.pageId)!;
    const copy = findPageById(definition, copied.pageId)!;
    expect(copy.id).not.toBe(original.id);
    const originalSectionIds = original.sections.map(({ id }) => id);
    for (const section of copy.sections) {
      expect(originalSectionIds).not.toContain(section.id);
      expect(section.id.startsWith(copy.id)).toBe(true);
    }
    expect(copy.sections.map(({ type }) => type)).toStrictEqual(
      original.sections.map(({ type }) => type),
    );
    expect(definition.pages.map(({ id }) => id)).toStrictEqual([
      homePage(definition).id,
      created.pageId,
      copied.pageId,
    ]);
  });

  it("makes no second copy when the same request is sent twice", async () => {
    const application = await openDraft();
    const created = await createPage(application);
    const command = {
      ...commandInputs,
      baseRevision: created.revision.revision,
      idempotencyKey: "duplicate-about-page-001",
      pageId: created.pageId,
      title: "About us copy",
      slug: "about-us-copy",
    };
    const first = await application.commands.duplicatePage(command);
    const second = await application.commands.duplicatePage(command);
    expect(second.replayed).toBe(true);
    expect(second.pageId).toBe(first.pageId);
    expect(second.revision.definition.pages).toHaveLength(3);
  });

  it("refuses a source page that is not in the draft", async () => {
    const application = await openDraft();
    const error = await refusal(() =>
      application.commands.duplicatePage({
        ...commandInputs,
        baseRevision: 0,
        idempotencyKey: "duplicate-missing-page01",
        pageId: "page_ffffffffffffffffffff",
        title: "Copy",
        slug: "copy",
      }),
    );
    expect((error as ContentPageOperationError).code).toBe("page_not_found");
  });
});

describe("deletePage", () => {
  it("removes the page from the draft", async () => {
    const application = await openDraft();
    const created = await createPage(application);
    const result = await application.commands.deletePage({
      ...commandInputs,
      baseRevision: created.revision.revision,
      idempotencyKey: "delete-about-page-000001",
      pageId: created.pageId,
    });
    expect(findPageById(result.revision.definition, created.pageId)).toBeUndefined();
    expect(result.revision.definition.pages).toHaveLength(1);
    // The delete is a draft change: the earlier revision still holds the page.
    expect(
      findPageById(created.revision.definition, created.pageId),
    ).toBeDefined();
  });

  it("refuses to delete the home page", async () => {
    const application = await openDraft();
    const error = await refusal(() =>
      application.commands.deletePage({
        ...commandInputs,
        baseRevision: 0,
        idempotencyKey: "delete-the-home-page-001",
        pageId: homePage(referenceSiteDefinition).id,
      }),
    );
    expect((error as ContentPageOperationError).code).toBe("page_is_home");
    expect(error.fields.pageId).toBe(
      "The home page cannot be deleted. Every site needs a home page.",
    );
  });

  it("refuses while a navigation item still links to the page", async () => {
    const application = await openDraft();
    const created = await createPage(application);
    const navigationItem =
      referenceSiteDefinition.site.navigation[0]!;
    const linked = await application.commands.save({
      ...commandInputs,
      baseRevision: created.revision.revision,
      idempotencyKey: "link-the-navigation-0001",
      edits: [
        { path: `${navigationItem.id}.href`, value: `page:${created.pageId}` },
      ],
    });
    const error = await refusal(() =>
      application.commands.deletePage({
        ...commandInputs,
        baseRevision: linked.revision,
        idempotencyKey: "delete-linked-page-00001",
        pageId: created.pageId,
      }),
    );
    expect(error).toBeInstanceOf(ContentPageOperationError);
    const blocked = error as ContentPageOperationError;
    expect(blocked.code).toBe("page_still_linked");
    expect(blocked.references).toStrictEqual([
      { location: "navigation", label: navigationItem.label },
    ]);
    expect(blocked.fields.pageId).toContain(
      `Navigation — ${navigationItem.label}`,
    );
    expect(blocked.fields.pageId).toContain("Change those links first");
  });

  it("allows the delete once the link has been changed", async () => {
    const application = await openDraft();
    const created = await createPage(application);
    const navigationItem = referenceSiteDefinition.site.navigation[0]!;
    const linked = await application.commands.save({
      ...commandInputs,
      baseRevision: created.revision.revision,
      idempotencyKey: "link-the-navigation-0001",
      edits: [
        { path: `${navigationItem.id}.href`, value: `page:${created.pageId}` },
      ],
    });
    const unlinked = await application.commands.save({
      ...commandInputs,
      baseRevision: linked.revision,
      idempotencyKey: "unlink-the-navigation-01",
      edits: [
        { path: `${navigationItem.id}.href`, value: navigationItem.href },
      ],
    });
    const result = await application.commands.deletePage({
      ...commandInputs,
      baseRevision: unlinked.revision,
      idempotencyKey: "delete-linked-page-00001",
      pageId: created.pageId,
    });
    expect(
      findPageById(result.revision.definition, created.pageId),
    ).toBeUndefined();
  });
});
