import { describe, expect, it } from "vitest";

import { referenceSiteDefinition } from "@foundry/site-definition";

import {
  durableSchemaRecoveryEdits,
  mergeDurableAndOutboxRecoveryEdits,
} from "./content-schema-recovery";

function legacyDefinition(
  name: string = referenceSiteDefinition.site.name,
) {
  const definition = structuredClone(referenceSiteDefinition) as any;
  definition.definitionVersion = "1.0.0";
  definition.schemaVersion = "1.0.0";
  delete definition.design;
  definition.home.sections.forEach((section: any) => {
    delete section.variant;
  });
  definition.site.name = name;
  return definition;
}

describe("content schema recovery", () => {
  it("carries a durable legacy edit relative to immutable revision zero", () => {
    expect(
      durableSchemaRecoveryEdits(
        legacyDefinition(),
        legacyDefinition("Saved legacy draft"),
      ),
    ).toEqual([
      {
        path: "site_foundry_reference.name",
        baseValue: "Foundry Reference",
        value: "Saved legacy draft",
      },
    ]);
  });

  it("adds current design defaults without treating them as legacy edits", () => {
    expect(
      durableSchemaRecoveryEdits(
        legacyDefinition(),
        legacyDefinition(),
      ),
    ).toEqual([]);
  });

  it("layers an unsaved value over the durable three-way base", () => {
    expect(
      mergeDurableAndOutboxRecoveryEdits(
        [
          {
            path: "site_foundry_reference.name",
            baseValue: "Foundry Reference",
            value: "Saved legacy draft",
          },
        ],
        [
          {
            path: "site_foundry_reference.name",
            baseValue: "Saved legacy draft",
            value: "Pending browser draft",
          },
        ],
      ),
    ).toEqual([
      {
        path: "site_foundry_reference.name",
        baseValue: "Foundry Reference",
        value: "Pending browser draft",
      },
    ]);
  });
});
