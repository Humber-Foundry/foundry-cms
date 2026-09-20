import {
  canonicalJson,
} from "@humber-foundry/application";
import {
  createRichTextDocumentFromPlainText,
  designContract,
  findPageById,
  isPageCompositionSlotId,
  listEditableSiteFields,
  pageMediaFieldPath,
  toPageComposition,
  type PageSection,
  type SiteDefinition,
} from "@humber-foundry/site-definition";
import { upgradeInstalledSiteDefinition } from "../foundry/site-definition";

import {
  excludeCompositionOwnedEdits,
  mergeRecoverySources,
  type StaleRecoveryEdit,
} from "./content-editor-recovery";

/**
 * The home page's media manifest path. Kept as an export because it is the one
 * a stored record written before a site had more than one page carries. Use
 * `pageMediaFieldPath(page)` for the path of any one page.
 */
export const mediaManifestRecoveryPath = "home.media";

/** Whether a record holds a page's media manifest rather than one field. */
export function isMediaManifestRecoveryPath(path: string): boolean {
  return path === mediaManifestRecoveryPath || path.endsWith(".media");
}

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
  const type = component.type as Exclude<PageSection["type"], "registered">;
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
    return upgradeInstalledSiteDefinition(definition);
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
  // Every page is compared with its own earlier self, so a structural change
  // on one page is written under that page's slot id and can only ever be
  // restored to that page. See ADR-0032.
  const mediaEdits: StaleRecoveryEdit[] = [];
  const compositionEdits: StaleRecoveryEdit[] = [];
  let keptFieldEdits = fieldEdits;
  for (const currentPage of current.pages) {
    const basePage = findPageById(base, currentPage.id);
    if (basePage === undefined) continue;
    const baseMedia = canonicalJson(basePage.media ?? []);
    const currentMedia = canonicalJson(currentPage.media ?? []);
    if (baseMedia !== currentMedia) {
      mediaEdits.push({
        path: pageMediaFieldPath(currentPage),
        baseValue: baseMedia,
        value: currentMedia,
      });
    }
    const baseComposition = toPageComposition(basePage);
    const currentComposition = toPageComposition(currentPage);
    if (
      JSON.stringify(baseComposition) === JSON.stringify(currentComposition)
    ) {
      continue;
    }
    const baseComponentIds = new Set(
      baseComposition.components.map(({ id }) => id),
    );
    compositionEdits.push({
      path: currentComposition.slotId,
      baseValue: JSON.stringify(baseComposition),
      value: JSON.stringify(currentComposition),
    });
    keptFieldEdits = excludeCompositionOwnedEdits(
      keptFieldEdits,
      currentPage,
      currentComposition.components.filter(
        ({ id }) => !baseComponentIds.has(id),
      ),
    );
  }
  return [...compositionEdits, ...mediaEdits, ...keptFieldEdits];
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
    typeof composition.slotId !== "string" ||
    !isPageCompositionSlotId(composition.slotId) ||
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
  return isPageCompositionSlotId(edit.path)
    ? {
        path: edit.path,
        baseValue: upgradeLegacyComposition(edit.baseValue),
        value: upgradeLegacyComposition(edit.value),
      }
    : edit;
}
