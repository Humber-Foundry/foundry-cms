import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";

import {
  createSiteId,
  referenceSiteDefinition,
  siteDefinitionSchema,
} from "./index";

describe("reference Site Definition", () => {
  const validate = new Ajv2020({ allErrors: true }).compile(
    siteDefinitionSchema,
  );

  it("declares stable product and schema versions", () => {
    expect(referenceSiteDefinition.definitionVersion).toBe("1.0.0");
    expect(referenceSiteDefinition.schemaVersion).toBe("1.0.0");
    expect(siteDefinitionSchema.$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    expect(siteDefinitionSchema.$id).toBe(
      "https://foundrycms.dev/schemas/site-definition/1.0.0",
    );
  });

  it("uses unique stable identifiers for every page section", () => {
    const identifiers = referenceSiteDefinition.home.sections.map(
      (section) => section.id,
    );

    expect(identifiers.length).toBeGreaterThanOrEqual(3);
    expect(new Set(identifiers).size).toBe(identifiers.length);
    expect(identifiers.every((id) => id.startsWith("section_"))).toBe(true);
  });

  it("rejects values that are not stable site identifiers", () => {
    expect(() => createSiteId("section_hero")).toThrow(TypeError);
    expect(createSiteId("site_second_example")).toBe("site_second_example");
  });

  it("validates the complete reference definition", () => {
    expect(validate(referenceSiteDefinition), validate.errors?.toString()).toBe(
      true,
    );
  });

  it.each([
    {
      name: "a non-string site identifier",
      change: (definition: Record<string, any>) => {
        definition.site.id = 42;
      },
    },
    {
      name: "a non-array sections value",
      change: (definition: Record<string, any>) => {
        definition.home.sections = "hero";
      },
    },
    {
      name: "an unknown nested property",
      change: (definition: Record<string, any>) => {
        definition.home.seo.injected = true;
      },
    },
    {
      name: "fields from the wrong section variant",
      change: (definition: Record<string, any>) => {
        definition.home.sections[0].metrics = [];
      },
    },
    {
      name: "an executable link target",
      change: (definition: Record<string, any>) => {
        definition.site.navigation[0].href = "data:text/html,<script></script>";
      },
    },
    {
      name: "an arbitrary off-site link target",
      change: (definition: Record<string, any>) => {
        definition.site.navigation[0].href = "https://example.com";
      },
    },
  ])("rejects $name", ({ change }) => {
    const malformed = structuredClone(referenceSiteDefinition) as unknown as Record<
      string,
      any
    >;
    change(malformed);

    expect(validate(malformed)).toBe(false);
  });
});
