import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import type { ContentRevision } from "@humber-foundry/application";

import {
  advanceWorkspaceRevisionHead,
  newestContentRevision,
} from "./workspace-revision";

describe("workspace revision head", () => {
  it("does not pass a server callback into the pre-workspace media client", async () => {
    const dashboardShell = await readFile(
      new URL("./dashboard-shell.tsx", import.meta.url),
      "utf8",
    );

    expect(dashboardShell).not.toContain(
      "onRevisionSaved={() => undefined}",
    );
    expect(dashboardShell).not.toContain("<MediaManager");
  });

  it("does not regress when an older response arrives last", () => {
    const newer = { revision: 3 } as ContentRevision;
    const older = { revision: 2 } as ContentRevision;

    expect(newestContentRevision(newer, older)).toBe(newer);
    expect(newestContentRevision(older, newer)).toBe(newer);
  });

  it("keeps the newest exact preview URL when an older response arrives last", () => {
    const newer = { revision: 3 } as ContentRevision;
    const older = { revision: 2 } as ContentRevision;
    const current = { revision: newer, previewUrl: "/preview/3" };

    expect(
      advanceWorkspaceRevisionHead(current, older, "/preview/2"),
    ).toBe(current);
  });

  it("shares runtime stale transitions with both workspace editors", async () => {
    const [workspaceEditors, mediaManager] = await Promise.all([
      readFile(new URL("./workspace-editors.tsx", import.meta.url), "utf8"),
      readFile(new URL("./media-manager.tsx", import.meta.url), "utf8"),
    ]);

    expect(workspaceEditors).toContain(
      "const [contentStale, setContentStale] = useState(",
    );
    expect(workspaceEditors.match(/onContentStale=/gu)).toHaveLength(2);
    expect(workspaceEditors).toContain("contentStale={contentStale}");
    expect(mediaManager).toContain(
      'result.body.error === "content_revision_stale"',
    );
    expect(mediaManager).toContain("onContentStale();");
  });

  it("invalidates revision-bound publication state when media advances the head", async () => {
    const editor = await readFile(
      new URL("./content-editor.tsx", import.meta.url),
      "utf8",
    );
    const externalRevisionEffect = editor.slice(
      editor.indexOf("if (revisionHead.revision > state.persistedRevision)"),
      editor.indexOf(
        "}, [persistence, revisionHead, state.persistedRevision]);",
      ),
    );

    expect(externalRevisionEffect).toContain("setApprovalId(null)");
    expect(externalRevisionEffect).toContain("setPreviewedRevision(null)");
    expect(externalRevisionEffect).toContain(
      "pendingPublicationAttempt.current = null",
    );
    expect(externalRevisionEffect).toContain(
      "pendingDeploymentRetryAttempt.current = null",
    );
    expect(editor).toContain(
      "if (latestRevisionHead.current !== attempt.revision)",
    );
  });
});
