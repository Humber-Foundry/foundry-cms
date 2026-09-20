import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { createContentWorkspaceId } from "@humber-foundry/application";
import { type SiteHref } from "@humber-foundry/site-definition";

import { twoPageSiteDefinition } from "@/src/test-support/two-page-site-definition";

const mocks = vi.hoisted(() => ({
  loadRevisionPreview: vi.fn(),
}));

// `revision-preview-page.ts` is server-only and calls React's `cache`. This
// test never runs its real `loadRevisionPreview`, but importing the actual
// module (to keep `buildRevisionPreviewLinks` real) still evaluates those
// top-level imports, exactly as `revision-preview-page.test.ts` mocks them.
vi.mock("server-only", () => ({}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    cache<T extends (...args: never[]) => unknown>(callback: T): T {
      return callback as T;
    },
  };
});

vi.mock("@/src/revision-preview-page", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/src/revision-preview-page")>();
  return { ...actual, loadRevisionPreview: mocks.loadRevisionPreview };
});

import RevisionPreviewPage, { generateMetadata } from "./page";

/**
 * A revision whose home page links to the second page through a navigation
 * item. Proves the home preview route's own `pageHref` (from
 * `buildRevisionPreviewLinks`, kept real above) sends that link to the other
 * page's preview address, not its live public path.
 */
function previewRevision() {
  const definition = {
    ...twoPageSiteDefinition,
    site: {
      ...twoPageSiteDefinition.site,
      navigation: [
        ...twoPageSiteDefinition.site.navigation,
        {
          id: "nav_about",
          label: "About",
          href: "page:page_about" as SiteHref,
        },
      ],
    },
  };
  return {
    workspaceId: createContentWorkspaceId("workspace_home_197"),
    revision: 7,
    createdAt: "2026-09-19T00:00:00.000Z",
    definition,
    inputs: {
      contentHash: "a".repeat(64),
      schemaVersion: definition.schemaVersion,
      rendererVersion: "renderer-197",
      productionBase: "b".repeat(40),
    },
  };
}

const props = {
  params: Promise.resolve({
    workspaceId: "workspace_home_197",
    revision: "7",
  }),
  searchParams: Promise.resolve({
    capability: "cap-197",
    bookmark: "bookmark-197",
  }),
};

describe("home revision preview route", () => {
  it("keeps a page: link inside this revision's preview", async () => {
    mocks.loadRevisionPreview.mockResolvedValue(previewRevision());

    const markup = renderToStaticMarkup(await RevisionPreviewPage(props));

    expect(markup).toContain(
      'href="/__foundry/preview/workspace_home_197/7/about' +
        '?capability=cap-197&amp;bookmark=bookmark-197"',
    );
    expect(markup).not.toContain('href="/about"');
  });

  it("emits the home page's own metadata", async () => {
    mocks.loadRevisionPreview.mockResolvedValue(previewRevision());

    const metadata = await generateMetadata(props);

    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
