import {
  defaultSiteDesign,
  designContract,
  listEditableSiteFields,
  pageCompositionContract,
  toPageComposition,
  type PageSection,
  type SiteDefinition,
} from "@foundry/site-definition";

import {
  excludeCompositionOwnedEdits,
  mergeRecoverySources,
  type StaleRecoveryEdit,
} from "./content-editor-recovery";

function upgradeLegacyDefinition(
  definition: SiteDefinition,
): SiteDefinition {
  if (definition.schemaVersion === "1.1.0") {
    return definition;
  }
  if ((definition.schemaVersion as string) !== "1.0.0") {
    throw new Error("unsupported_site_definition_schema");
  }
  const legacy = definition as unknown as Omit<
    SiteDefinition,
    "definitionVersion" | "schemaVersion" | "design" | "home"
  > & {
    home: Omit<SiteDefinition["home"], "sections"> & {
      sections: ReadonlyArray<Omit<PageSection, "variant">>;
    };
  };
  return {
    ...legacy,
    definitionVersion: "1.1.0",
    schemaVersion: "1.1.0",
    design: defaultSiteDesign,
    home: {
      ...legacy.home,
      sections: legacy.home.sections.map((section) => {
        if (!(section.type in designContract.variants)) {
          throw new Error("unsupported_page_component");
        }
        const type = section.type as PageSection["type"];
        return {
          ...section,
          variant: designContract.variants[type].values[0],
        } as PageSection;
      }),
    },
  };
}

export function durableSchemaRecoveryEdits(
  baseDefinition: SiteDefinition,
  currentDefinition: SiteDefinition,
): StaleRecoveryEdit[] {
  const base = upgradeLegacyDefinition(baseDefinition);
  const current = upgradeLegacyDefinition(currentDefinition);
  const baseFields = new Map(
    listEditableSiteFields(base).map(({ path, value }) => [path, value]),
  );
  const fieldEdits = listEditableSiteFields(current).flatMap(
    ({ path, value }) => {
      const baseValue = baseFields.get(path);
      return baseValue === undefined || baseValue === value
        ? []
        : [{ path, baseValue, value }];
    },
  );
  const baseComposition = toPageComposition(base);
  const currentComposition = toPageComposition(current);
  if (
    JSON.stringify(baseComposition) === JSON.stringify(currentComposition)
  ) {
    return fieldEdits;
  }
  const baseComponentIds = new Set(
    baseComposition.components.map(({ id }) => id),
  );
  return [
    {
      path: pageCompositionContract.slot.id,
      baseValue: JSON.stringify(baseComposition),
      value: JSON.stringify(currentComposition),
    },
    ...excludeCompositionOwnedEdits(
      fieldEdits,
      currentComposition.components.filter(
        ({ id }) => !baseComponentIds.has(id),
      ),
    ),
  ];
}

export function mergeDurableAndOutboxRecoveryEdits(
  durableEdits: ReadonlyArray<StaleRecoveryEdit>,
  outboxEdits: ReadonlyArray<StaleRecoveryEdit>,
): StaleRecoveryEdit[] {
  return mergeRecoverySources(durableEdits, outboxEdits);
}
