import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { createContentWorkspaceId } from "@humber-foundry/application";

import { twoPageSiteDefinition } from "@/src/test-support/two-page-site-definition";

const mocks = vi.hoisted(() => ({
  loadRevisionPreview: vi.fn(),
}));

// See the home preview route's test for why "server-only" and React's
// `cache` need mocking even though this test never runs the real
// `loadRevisionPreview`.
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
vi.mock("next/navigation", () => ({
  notFound() {
    throw new Error("not_found");
  },
}));
vi.mock("@/src/revision-preview-page", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/src/revision-preview-page")>();
  return { ...actual, loadRevisionPreview: mocks.loadRevisionPreview };
});

import SitePagePreviewPage, { generateMetadata } from "./page";

function previewRevision() {
  return {
    workspaceId: createContentWorkspaceId("workspace_page_197"),
    revision: 9,
    createdAt: "2026-09-19T00:00:00.000Z",
    definition: twoPageSiteDefinition,
    inputs: {
      contentHash: "a".repeat(64),
      schemaVersion: twoPageSiteDefinition.schemaVersion,
      rendererVersion: "renderer-197",
      productionBase: "b".repeat(40),
    },
  };
}

function propsFor(slug: string) {
  return {
    params: Promise.resolve({
      workspaceId: "workspace_page_197",
      revision: "9",
      slug,
    }),
    searchParams: Promise.resolve({
      capability: "cap-197",
      bookmark: "bookmark-197",
    }),
  };
}

describe("page revision preview route", () => {
  it("loads the revision, finds the page, and renders it inside the preview", async () => {
    mocks.loadRevisionPreview.mockResolvedValue(previewRevision());

    const markup = renderToStaticMarkup(
      await SitePagePreviewPage(propsFor("about")),
    );

    expect(markup).toContain(
      'href="/__foundry/preview/workspace_page_197/9' +
        '?capability=cap-197&amp;bookmark=bookmark-197"',
    );
    expect(markup).not.toContain('href="/"');
  });

  it("emits the page's own metadata", async () => {
    mocks.loadRevisionPreview.mockResolvedValue(previewRevision());

    const metadata = await generateMetadata(propsFor("about"));

    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("shows the preview's not-found state for an unknown slug", async () => {
    mocks.loadRevisionPreview.mockResolvedValue(previewRevision());

    await expect(
      SitePagePreviewPage(propsFor("missing-page")),
    ).rejects.toThrow("not_found");
  });
});
