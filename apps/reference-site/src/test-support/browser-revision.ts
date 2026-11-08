import { referenceSiteDefinition } from "@humber-foundry/site-definition";

/**
 * The saved revision a browser test opens the editor on: revision 4 of the
 * reference site, in the named workspace.
 */
export function browserRevision(workspaceId: string) {
  return {
    workspaceId,
    revision: 4,
    definition: referenceSiteDefinition,
    inputs: {
      contentHash: "browser-content-hash",
      schemaVersion: "1.2.0",
      rendererVersion: "renderer-browser",
      productionBase: "published-browser",
    },
    createdAt: "2026-07-27T00:00:00.000Z",
    createdBy: "membership-browser",
  } as never;
}
