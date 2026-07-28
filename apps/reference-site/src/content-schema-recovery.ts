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

function upgradeLegacyPageComponent(component: unknown): PageSection {
  if (
    typeof component !== "object" ||
    component === null ||
    !("type" in component) ||
    typeof component.type !== "string" ||
    !(component.type in designContract.variants)
  ) {
    throw new Error("unsupported_legacy_page_component");
  }
  const type = component.type as PageSection["type"];
  if ("variant" in component) {
    if (
      typeof component.variant !== "string" ||
      !designContract.variants[type].values.includes(
        component.variant as never,
      )
    ) {
      throw new Error("unsupported_legacy_component_variant");
    }
    return component as PageSection;
  }
  return {
    ...component,
    variant: designContract.variants[type].values[0],
  } as PageSection;
}

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
      sections: legacy.home.sections.map(upgradeLegacyPageComponent),
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
  return mergeRecoverySources(
    durableEdits,
    upgradeLegacyRecoveryEdits(outboxEdits),
  );
}

export function upgradeLegacyRecoveryEdits(
  edits: ReadonlyArray<StaleRecoveryEdit>,
): StaleRecoveryEdit[] {
  return edits.map(upgradeLegacyStructuralRecoveryEdit);
}

function upgradeLegacyComposition(encoded: string): string {
  const composition: unknown = JSON.parse(encoded);
  if (
    typeof composition !== "object" ||
    composition === null ||
    !("slotId" in composition) ||
    composition.slotId !== pageCompositionContract.slot.id ||
    !("components" in composition) ||
    !Array.isArray(composition.components)
  ) {
    throw new Error("invalid_legacy_page_composition");
  }
  return JSON.stringify({
    ...composition,
    components: composition.components.map(upgradeLegacyPageComponent),
  });
}

function upgradeLegacyStructuralRecoveryEdit(
  edit: StaleRecoveryEdit,
): StaleRecoveryEdit {
  return edit.path === pageCompositionContract.slot.id
    ? {
        ...edit,
        baseValue: upgradeLegacyComposition(edit.baseValue),
        value: upgradeLegacyComposition(edit.value),
      }
    : edit;
}
