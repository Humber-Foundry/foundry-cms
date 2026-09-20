import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("../foundry/site-definition", async () => {
  const { withSecondPage } = await import(
    "./test-support/two-page-site-definition"
  );
  return { installedSiteDefinition: withSecondPage() };
});

import {
  secondPageId,
  secondPageSlug,
} from "./test-support/two-page-site-definition";
import { installedSiteDefinition } from "../foundry/site-definition";
import { currentRouteHistory } from "./analytics-projection-runtime";

/**
 * `currentRouteHistory` is the map Cloudflare Web Analytics traffic is
 * attributed through (ADR-0003's `content.page_views`). This file proves it
 * against a two-page fixture, separate from
 * `analytics-projection-runtime.test.ts`'s D1-backed suite, so it never opens
 * a database connection. See ADR-0026.
 */
describe("currentRouteHistory with more than one page", () => {
  it("maps every page to its own path and its own content id", () => {
    const history = currentRouteHistory();
    const home = installedSiteDefinition.pages[0]!;

    expect(
      history.some(
        (entry) => entry.path === "/" && entry.contentId === home.id,
      ),
    ).toBe(true);
    expect(
      history.some(
        (entry) =>
          entry.path === `/${secondPageSlug}` &&
          entry.contentId === secondPageId,
      ),
    ).toBe(true);
  });

  it("gives every page a distinct path, so traffic is never merged", () => {
    const paths = currentRouteHistory()
      .filter((entry) => !entry.path.startsWith("/blog/"))
      .map((entry) => entry.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
