import {
  applyPageComposition,
  createDefaultPageSection,
  pageCompositionContract,
  type PageComponentType,
  type PageSection,
  type SiteDefinition,
} from "@foundry/site-definition";

export type PageCompositionPuckData = {
  root: { props: Record<string, never> };
  content: Array<
    {
      type: PageComponentType;
      props: PageSection;
    }
  >;
};

export type PageCompositionPuckResult =
  | Readonly<{ ok: true; definition: SiteDefinition }>
  | Readonly<{ ok: false; errors: Readonly<Record<string, string>> }>;

export function definitionToPuckData(
  definition: SiteDefinition,
): PageCompositionPuckData {
  return {
    root: { props: {} },
    content: definition.home.sections.map((section) => ({
      type: section.type,
      props: section,
    })),
  };
}

function stableComponentId(
  type: PageComponentType,
  candidate: unknown,
): string | null {
  if (
    typeof candidate === "string" &&
    /^section_[a-z0-9_]+$/u.test(candidate)
  ) {
    return candidate;
  }
  const suffix =
    typeof candidate === "string"
      ? candidate.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "")
      : "";
  if (suffix === "") {
    return null;
  }
  const typeSlug = type.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
  return `section_${typeSlug}_${suffix}`;
}

function isPageComponentType(value: unknown): value is PageComponentType {
  return (
    typeof value === "string" &&
    Object.hasOwn(pageCompositionContract.components, value)
  );
}

function remapNestedIds(section: Record<string, unknown>, rootId: string): void {
  let sequence = 0;
  const visit = (value: unknown, root: boolean): void => {
    if (Array.isArray(value)) {
      value.forEach((nested) => visit(nested, false));
      return;
    }
    if (typeof value !== "object" || value === null) {
      return;
    }
    const record = value as Record<string, unknown>;
    if (!root && typeof record.id === "string") {
      sequence += 1;
      record.id = `${rootId}_item_${sequence}`;
    }
    Object.values(record).forEach((nested) => visit(nested, false));
  };
  visit(section, true);
}

export function puckDataToDefinition(
  definition: SiteDefinition,
  value: unknown,
): PageCompositionPuckResult {
  if (
    typeof value !== "object" ||
    value === null ||
    !("content" in value) ||
    !Array.isArray(value.content)
  ) {
    return {
      ok: false,
      errors: {
        [pageCompositionContract.slot.id]:
          "The visual editor returned an invalid page slot.",
      },
    };
  }
  const ids = new Set<string>();
  const components: PageSection[] = [];
  for (const item of value.content) {
    if (
      typeof item !== "object" ||
      item === null ||
      !("type" in item) ||
      !isPageComponentType(item.type) ||
      !("props" in item) ||
      typeof item.props !== "object" ||
      item.props === null
    ) {
      return {
        ok: false,
        errors: {
          [pageCompositionContract.slot.id]:
            "Only registered page components can enter this slot.",
        },
      };
    }
    const componentType = item.type as PageComponentType;
    const id = stableComponentId(
      componentType,
      "id" in item.props ? item.props.id : undefined,
    );
    if (id === null || ids.has(id)) {
      return {
        ok: false,
        errors: {
          [pageCompositionContract.slot.id]:
            "Every Puck component needs one unique stable identifier.",
        },
      };
    }
    ids.add(id);
    const existing = definition.home.sections.find(
      (section) => section.id === id && section.type === componentType,
    );
    const base =
      existing ??
      createDefaultPageSection(componentType, id);
    const editableProps =
      pageCompositionContract.components[componentType].editableProps;
    const section = structuredClone(base) as unknown as Record<
      string,
      unknown
    >;
    const props = item.props as Record<string, unknown>;
    for (const property of editableProps) {
      if (typeof props[property] === "string") {
        section[property] = props[property];
      }
    }
    // A Puck duplicate gets a fresh root id but keeps the registered,
    // non-editable scaffold from its source component.
    const duplicateSource =
      existing === undefined
        ? definition.home.sections.find((source) => {
            if (source.type !== componentType) {
              return false;
            }
            const sourceRecord = source as unknown as Record<string, unknown>;
            return Object.entries(sourceRecord).every(
              ([key, propertyValue]) =>
                key === "id" ||
                key === "type" ||
                editableProps.includes(key) ||
                JSON.stringify(props[key]) === JSON.stringify(propertyValue),
            );
          })
        : undefined;
    if (duplicateSource !== undefined) {
      for (const [key, propertyValue] of Object.entries(duplicateSource)) {
        if (
          key !== "id" &&
          key !== "type" &&
          !editableProps.includes(key) &&
          key in section
        ) {
          section[key] = structuredClone(propertyValue);
        }
      }
      remapNestedIds(section, id);
    }
    section.id = id;
    section.type = componentType;
    components.push(section as unknown as PageSection);
  }
  return applyPageComposition(definition, {
    slotId: pageCompositionContract.slot.id,
    components,
  });
}

export function pageCompositionChanged(
  persisted: SiteDefinition,
  working: SiteDefinition,
): boolean {
  const identity = (definition: SiteDefinition) =>
    definition.home.sections.map(({ id, type }) => ({ id, type }));
  return JSON.stringify(identity(persisted)) !== JSON.stringify(identity(working));
}
