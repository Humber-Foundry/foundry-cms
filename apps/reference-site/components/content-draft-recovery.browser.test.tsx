import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { ContentDraftRecovery } from "./content-draft-recovery";

const oldDraftWorkspaceId = "workspace_aaaaaaaaaaaaaaaaaaaaaaaa";
const preservedRevision = {
  workspaceId: oldDraftWorkspaceId,
  revision: 4,
  schemaVersion: "1.6.0",
} as never;

const mounted: Array<() => void> = [];

function mount(reason: "older-schema" | "site-updated") {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => {
    root.render(
      createElement(ContentDraftRecovery, {
        csrfToken: "csrf-recovery-test",
        preservedRevision,
        reason,
      }),
    );
  });
  mounted.push(() => {
    root.unmount();
    host.remove();
  });
  return host;
}

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

describe("content draft recovery screen", () => {
  it("offers one way forward, and never a first-visit step", () => {
    const host = mount("older-schema");

    expect(host.textContent).toContain("Start a fresh draft");
    // The first-visit prompt this screen replaced must not come back: the
    // dashboard creates the draft workspace on the server.
    expect(host.textContent).not.toContain("Start workspace");
    expect(
      [...host.querySelectorAll("button")].map((button) => button.textContent),
    ).toEqual(["Start a fresh draft"]);
  });

  it("promises carried-over changes only for an older-schema draft", () => {
    const older = mount("older-schema").textContent ?? "";
    const updated = mount("site-updated").textContent ?? "";

    expect(older).toContain("older version of your site");
    expect(older).toContain("changes that still fit are copied across");

    // Nothing is carried out of the stored draft in this case, so the screen
    // must not say anything is.
    expect(updated).toContain("Your site was updated after this draft");
    expect(updated).not.toContain("copied across");
  });

  it("links the old draft only where that link opens it", () => {
    const olderLinks = [
      ...mount("older-schema").querySelectorAll("a"),
    ].map((link) => link.getAttribute("href"));
    const updatedLinks = [
      ...mount("site-updated").querySelectorAll("a"),
    ].map((link) => link.getAttribute("href"));

    // Pages shows this same recovery screen for an older-schema draft, so a
    // link there would be a loop with no way to the draft.
    expect(olderLinks).toEqual([]);
    expect(updatedLinks).toEqual([
      `/dash/pages?workspace=${oldDraftWorkspaceId}`,
    ]);
  });
});
