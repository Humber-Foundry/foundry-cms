import {
  canonicalJson,
} from "@foundry/application";
import {
  createRichTextDocumentFromPlainText,
  designContract,
  listEditableSiteFields,
  pageCompositionContract,
  toPageComposition,
  upgradeSiteDefinition,
  type PageSection,
  type SiteDefinition,
} from "@foundry/site-definition";

import {
  excludeCompositionOwnedEdits,
  mergeRecoverySources,
  type StaleRecoveryEdit,
} from "./content-editor-recovery";

export const mediaManifestRecoveryPath = "home.media";

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
  let upgraded: Record<string, unknown> = { ...component };
  if ("variant" in upgraded) {
    if (
      typeof upgraded.variant !== "string" ||
      !designContract.variants[type].values.includes(
        upgraded.variant as never,
      )
    ) {
      throw new Error("unsupported_legacy_component_variant");
    }
  } else {
    upgraded = {
      ...upgraded,
      variant: designContract.variants[type].values[0],
    };
  }
  if (
    type === "callToAction" &&
    "body" in upgraded &&
    typeof upgraded.body === "string"
  ) {
    upgraded = {
      ...upgraded,
      body: createRichTextDocumentFromPlainText(upgraded.body),
    };
  }
  return upgraded as PageSection;
}

export function upgradeSiteDefinitionForCurrentSchema(
  definition: SiteDefinition,
): SiteDefinition {
  try {
    return upgradeSiteDefinition(definition);
  } catch {
    throw new Error("unsupported_site_definition_schema");
  }
}

export function durableSchemaRecoveryEdits(
  baseDefinition: SiteDefinition,
  currentDefinition: SiteDefinition,
): StaleRecoveryEdit[] {
  const base = upgradeSiteDefinitionForCurrentSchema(baseDefinition);
  const current = upgradeSiteDefinitionForCurrentSchema(currentDefinition);
  const baseFields = new Map(
    listEditableSiteFields(base).map((field) => [field.path, field]),
  );
  const fieldEdits = listEditableSiteFields(current).flatMap(
    ({ path, value, format }) => {
      const baseField = baseFields.get(path);
      if (baseField === undefined || baseField.value === value) {
        return [];
      }
      if (format === "richText") {
        return baseField.format === "richText"
          ? [
              {
                path,
                format,
                baseValue: baseField.value,
                value,
              },
            ]
          : [];
      }
      return [
        {
          path,
          baseValue: baseField.value,
          value,
        },
      ];
    },
  ) satisfies StaleRecoveryEdit[];
  const baseComposition = toPageComposition(base);
  const currentComposition = toPageComposition(current);
  const baseMedia = canonicalJson(base.home.media ?? []);
  const currentMedia = canonicalJson(current.home.media ?? []);
  const mediaEdits =
    baseMedia === currentMedia
      ? []
      : [
          {
            path: mediaManifestRecoveryPath,
            baseValue: baseMedia,
            value: currentMedia,
          },
        ];
  if (
    JSON.stringify(baseComposition) === JSON.stringify(currentComposition)
  ) {
    return [...mediaEdits, ...fieldEdits];
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
    ...mediaEdits,
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
        path: edit.path,
        baseValue: upgradeLegacyComposition(edit.baseValue),
        value: upgradeLegacyComposition(edit.value),
      }
    : edit;
}
