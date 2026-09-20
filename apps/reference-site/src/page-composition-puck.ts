import {
  applyPageComposition,
  createDefaultPageSection,
  pageCompositionSlotId,
  remapPageSectionNestedIds,
  replacePage,
  toPageCompositionIdentity,
  foundationPageComponentRegistry,
  mergePageComponentFieldEdit,
  type PageComponentRegistry,
  type PageSection,
  type SiteDefinition,
  type SitePage,
} from "@humber-foundry/site-definition";

export type PageCompositionPuckData = {
  root: { props: Record<string, never> };
  content: Array<
    {
      type: string;
      props: Record<string, unknown>;
    }
  >;
};

export type PageCompositionPuckResult =
  | Readonly<{ ok: true; definition: SiteDefinition }>
  | Readonly<{ ok: false; errors: Readonly<Record<string, string>> }>;

/**
 * One page drawn as the canvas reads it. `page` is the page the owner opened,
 * so the canvas always shows the sections of that page and no other.
 */
export function definitionToPuckData(
  page: SitePage,
  registry: PageComponentRegistry = foundationPageComponentRegistry,
): PageCompositionPuckData {
  return {
    root: { props: {} },
    content: page.sections.map((section) =>
      section.type === "registered"
        ? {
            type: registry.keyFor(section),
            props: {
              id: section.id,
              type: section.type,
              component: section.component,
              ...section.props,
            },
          }
        : { type: registry.keyFor(section), props: section },
    ),
  };
}

function stableComponentId(
  type: string,
  candidate: unknown,
): string | null {
  if (
    typeof candidate === "string" &&
    /^[a-z][a-z0-9_]*$/u.test(candidate)
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

function isPageComponentType(
  value: unknown,
  registry: PageComponentRegistry,
): value is string {
  return (
    typeof value === "string" &&
    Object.hasOwn(registry.components, value)
  );
}

/**
 * What the canvas now holds, written back onto one page.
 *
 * `page` is the page the owner opened. Every read of existing sections and
 * every write below is of that page, so a change made on one page cannot
 * reach another. See ADR-0032.
 */
export function puckDataToDefinition(
  definition: SiteDefinition,
  page: SitePage,
  value: unknown,
  registry: PageComponentRegistry = foundationPageComponentRegistry,
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
        [pageCompositionSlotId(page)]:
          "The visual editor returned an invalid page slot.",
      },
    };
  }
  const submittedIds = new Set(
    value.content.flatMap((item) => {
      if (
        typeof item !== "object" ||
        item === null ||
        !("type" in item) ||
        !isPageComponentType(item.type, registry) ||
        !("props" in item) ||
        typeof item.props !== "object" ||
        item.props === null
      ) {
        return [];
      }
      const id = stableComponentId(
        item.type,
        "id" in item.props ? item.props.id : undefined,
      );
      return id === null ? [] : [id];
    }),
  );
  const ids = new Set<string>();
  const components: PageSection[] = [];
  for (const item of value.content) {
    if (
      typeof item !== "object" ||
      item === null ||
      !("type" in item) ||
      !isPageComponentType(item.type, registry) ||
      !("props" in item) ||
      typeof item.props !== "object" ||
      item.props === null
    ) {
      return {
        ok: false,
        errors: {
          [pageCompositionSlotId(page)]:
            "Only registered page components can enter this slot.",
        },
      };
    }
    const componentType = item.type;
    const id = stableComponentId(
      componentType,
      "id" in item.props ? item.props.id : undefined,
    );
    if (id === null || ids.has(id)) {
      return {
        ok: false,
        errors: {
          [pageCompositionSlotId(page)]:
            "Every Puck component needs one unique stable identifier.",
        },
      };
    }
    ids.add(id);
    const existing = page.sections.find(
      (section) =>
        section.id === id && registry.keyFor(section) === componentType,
    );
    const submittedContextPage = {
      ...page,
      sections: [
        ...components,
        ...page.sections.filter(
          ({ id: existingId }) =>
            submittedIds.has(existingId) &&
            !components.some(
              ({ id: submittedId }) => submittedId === existingId,
            ),
        ),
      ],
    };
    const base =
      existing ??
      createDefaultPageSection(
        componentType,
        id,
        {
          definition: replacePage(definition, submittedContextPage),
          page: submittedContextPage,
        },
        registry,
      );
    const registration = registry.components[componentType]!;
    const editableProps = registration.editableFields;
    const section = structuredClone(base) as unknown as Record<
      string,
      unknown
    >;
    const props = item.props as Record<string, unknown>;
    const editableTarget =
      base.type === "registered"
        ? (structuredClone(base.props) as Record<string, unknown>)
        : section;
    for (const property of editableProps) {
      if (
        componentType === "callToAction" &&
        property === "body" &&
        props[property] !== undefined
      ) {
        if (
          typeof props[property] !== "object" ||
          props[property] === null ||
          Array.isArray(props[property])
        ) {
          return {
            ok: false,
            errors: {
              [`${id}.body`]:
                "The visual editor must preserve the versioned rich-text document.",
            },
          };
        }
        editableTarget[property] = mergePageComponentFieldEdit(
          registration.fields[property]!,
          editableTarget[property],
          props[property],
        );
      } else if (props[property] !== undefined) {
        editableTarget[property] = mergePageComponentFieldEdit(
          registration.fields[property]!,
          editableTarget[property],
          props[property],
        );
      }
    }
    if (base.type === "registered") section.props = editableTarget;
    // A Puck duplicate gets a fresh root id but keeps the registered,
    // non-editable scaffold from its source component.
    const duplicateSource =
      existing === undefined
        ? [...page.sections, ...components].find((source) => {
            if (registry.keyFor(source) !== componentType) {
              return false;
            }
            if (source.type === "registered") {
              return Object.entries(registration.fields).every(
                ([key, field]) =>
                  JSON.stringify(
                    mergePageComponentFieldEdit(
                      field,
                      source.props[key],
                      props[key],
                    ),
                  ) === JSON.stringify(props[key]),
              );
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
      if (
        base.type === "registered" &&
        duplicateSource.type === "registered"
      ) {
        for (const [key, propertyValue] of Object.entries(
          duplicateSource.props,
        )) {
          const field = registration.fields[key];
          if (field === undefined) continue;
          editableTarget[key] = mergePageComponentFieldEdit(
            field,
            propertyValue,
            editableTarget[key],
          );
        }
        section.props = editableTarget;
      } else {
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
      }
      Object.assign(
        section,
        remapPageSectionNestedIds(section as unknown as PageSection),
      );
    }
    section.id = id;
    if (base.type !== "registered") section.type = componentType;
    components.push(section as unknown as PageSection);
  }
  return applyPageComposition(definition, page, {
    slotId: pageCompositionSlotId(page),
    components,
  }, registry);
}

/**
 * Whether one page's structure differs between two drafts: its sections, their
 * order, their type, and the scaffolding of its registered sections.
 *
 * Both pages are the same page read from two drafts, so a caller compares like
 * with like. A page absent from one of the drafts counts as changed.
 */
export function pageCompositionChanged(
  persisted: SitePage | undefined,
  working: SitePage | undefined,
  registry: PageComponentRegistry = foundationPageComponentRegistry,
): boolean {
  if (persisted === undefined || working === undefined) {
    return persisted !== working;
  }
  return (
    JSON.stringify(toPageCompositionIdentity(persisted, registry)) !==
      JSON.stringify(toPageCompositionIdentity(working, registry)) ||
    JSON.stringify(
      persisted.sections.filter(({ type }) => type === "registered"),
    ) !==
      JSON.stringify(
        working.sections.filter(({ type }) => type === "registered"),
      )
  );
}
