import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { createContentWorkspaceId } from "@humber-foundry/application";
import { referenceSiteDefinition } from "@humber-foundry/site-definition";

import { PreviewProvenance } from "./preview-provenance";

const revision = {
  workspaceId: createContentWorkspaceId("workspace_home"),
  revision: 3,
  createdAt: "2026-09-20T00:00:00.000Z",
  inputs: {
    contentHash: "a".repeat(64),
    schemaVersion: referenceSiteDefinition.schemaVersion,
    rendererVersion: "renderer-x",
    productionBase: "b".repeat(40),
  },
};

describe("PreviewProvenance", () => {
  it("shows the MCP review summary by default when one is present", () => {
    const markup = renderToStaticMarkup(
      <PreviewProvenance
        revision={{
          ...revision,
          mcpReview: {
            previewId: "preview-1",
            actorId: "agent-1",
            pages: [],
            changedDocuments: ["Home — Hero title"],
            designChanges: [],
            publicEffect: "The home page changes.",
          },
        }}
      />,
    );
    expect(markup).toContain("agent-1");
    expect(markup).toContain("The home page changes.");
  });

  it("hides the MCP review summary when showMcpReview is false, even when one is present", () => {
    // The blog post preview route passes this. It never showed the MCP
    // review block before #156, and #156 must not change what it shows.
    const markup = renderToStaticMarkup(
      <PreviewProvenance
        revision={{
          ...revision,
          mcpReview: {
            previewId: "preview-1",
            actorId: "agent-1",
            pages: [],
            changedDocuments: ["A blog post — Title"],
            designChanges: [],
            publicEffect: "A blog post changes.",
          },
        }}
        showMcpReview={false}
      />,
    );
    expect(markup).not.toContain("agent-1");
    expect(markup).not.toContain("A blog post changes.");
  });

  it("links back to the editor for this workspace", () => {
    const markup = renderToStaticMarkup(
      <PreviewProvenance revision={revision} />,
    );
    expect(markup).toContain('href="/dash/pages?workspace=workspace_home"');
  });
});
