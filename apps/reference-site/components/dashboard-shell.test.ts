import { describe, expect, it } from "vitest";

import type { ContentRevision } from "@foundry/application";
import { referenceSiteDefinition } from "@foundry/site-definition";

import { contentWorkspaceRequiresSchemaRecovery } from "./dashboard-shell";

describe("dashboard content-workspace compatibility", () => {
  const revision = {
    definition: referenceSiteDefinition,
    inputs: {
      schemaVersion: "1.2.0",
    },
  } as unknown as ContentRevision;

  it("uses a recovery shell instead of mounting current-schema fields for a legacy revision", () => {
    expect(
      contentWorkspaceRequiresSchemaRecovery(referenceSiteDefinition, {
        ...revision,
        inputs: { ...revision.inputs, schemaVersion: "1.0.0" },
      }),
    ).toBe(true);
  });

  it("mounts the editor for a current-schema revision", () => {
    expect(
      contentWorkspaceRequiresSchemaRecovery(
        referenceSiteDefinition,
        revision,
      ),
    ).toBe(false);
  });
});
