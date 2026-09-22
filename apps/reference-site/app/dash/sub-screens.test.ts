import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  audienceDestinations,
  settingsDestination,
  siteDestinations,
} from "@/components/dashboard-destinations";
import { settingsTabs } from "@/components/settings-tabs";

/**
 * #227: every dashboard sub-screen starts with the shared back link.
 *
 * A sub-screen is a route under `/dash` the owner reaches from another
 * screen. The sidebar does not open it. This test lists every route under
 * `app/dash/` from the file system, takes away the screens the sidebar opens
 * directly, and checks that each screen left renders `DashboardBackLink` as
 * the first thing inside `<main>`. A new route with no back link fails here.
 *
 * Two kinds of route are not sub-screens:
 *
 * - A sidebar destination (`dashboard-destinations.ts`). The owner opens it
 *   from the sidebar, so there is nothing to go back to.
 * - A Settings tab (`settings-tabs.tsx`). The tabs are the sections of one
 *   sidebar destination; the sidebar marks Settings as current on all of
 *   them, and a "Back to Settings" link on the Settings screen itself would
 *   point at the screen the owner is already on.
 *
 * A route that only redirects (no `<main>` of its own) draws no screen, so
 * it has nothing to put a back link on. The test checks that such a route
 * really does redirect; it does not skip the route without a check.
 *
 * This test reads each page's source text, in the way a lint rule would,
 * instead of rendering every route with its own set of mocks. It proves the
 * back link is written first inside `<main>`; the render-level tests beside
 * each page prove what the screen shows.
 */
const dashDirectory = fileURLToPath(new URL(".", import.meta.url));

function listPageFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listPageFiles(path));
    else if (entry.name === "page.tsx") files.push(path);
  }
  return files.sort();
}

function routeOf(pageFile: string): string {
  const inside = relative(dashDirectory, pageFile).replace(/\/?page\.tsx$/u, "");
  return inside === "" ? "/dash" : `/dash/${inside}`;
}

const sidebarRoutes = new Set([
  ...siteDestinations.map((destination) => destination.href),
  ...audienceDestinations.map((destination) => destination.href),
  settingsDestination.href,
  ...settingsTabs.map((tab) => tab.href),
]);

const routes = listPageFiles(dashDirectory).map((file) => ({
  route: routeOf(file),
  source: readFileSync(file, "utf8"),
}));

const subScreens = routes.filter(({ route }) => !sidebarRoutes.has(route));

describe("dashboard sub-screens (#227)", () => {
  it("finds the routes the file system holds", () => {
    // Guards the listing itself: if the walk found nothing, every check
    // below would pass for the wrong reason.
    expect(routes.map(({ route }) => route)).toEqual(
      expect.arrayContaining(["/dash", "/dash/settings/connect-agent"]),
    );
    expect(subScreens.map(({ route }) => route)).toEqual(
      expect.arrayContaining([
        "/dash/campaigns/new",
        "/dash/campaigns/[campaignId]",
        "/dash/forms/[receiptId]",
        "/dash/review/[previewId]",
        "/dash/settings/connect-agent",
      ]),
    );
  });

  it.each(subScreens.map(({ route, source }) => [route, source]))(
    "%s renders the shared back link first inside <main>",
    (route, source) => {
      if (!source.includes("<main")) {
        // No screen of its own: it must hand the browser somewhere else.
        expect(source, `${route} draws nothing and does not redirect`).toMatch(
          /\bredirect\(/u,
        );
        return;
      }
      expect(source).toContain('from "@/components/dashboard-back-link"');
      // The back link is the first element after <main ...>, allowing only a
      // JSX comment between them.
      expect(source).toMatch(
        /<main\b[^>]*>\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)*<DashboardBackLink\b/u,
      );
    },
  );
});
