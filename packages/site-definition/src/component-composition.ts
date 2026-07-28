import type {
  PageSection,
  SiteDefinition,
} from "./index";

export type PageComponentType = PageSection["type"];

export type PageComposition = Readonly<{
  slotId: "slot_home_sections";
  components: ReadonlyArray<PageSection>;
}>;

export type PageCompositionResult =
  | Readonly<{ ok: true; definition: SiteDefinition }>
  | Readonly<{ ok: false; errors: Readonly<Record<string, string>> }>;

type ComponentRegistration = Readonly<{
  label: string;
  editableProps: ReadonlyArray<string>;
}>;

export const pageCompositionContract = Object.freeze({
  slot: Object.freeze({
    id: "slot_home_sections" as const,
    path: "home.sections" as const,
    minItems: 1,
    maxItems: 12,
    allowedComponents: Object.freeze([
      "hero",
      "services",
      "proof",
      "callToAction",
    ] as const),
  }),
  components: Object.freeze({
    hero: Object.freeze({
      label: "Hero",
      editableProps: Object.freeze(["eyebrow", "title", "summary"]),
    }),
    services: Object.freeze({
      label: "Services",
      editableProps: Object.freeze(["eyebrow", "title", "introduction"]),
    }),
    proof: Object.freeze({
      label: "Proof",
      editableProps: Object.freeze(["quote", "attribution"]),
    }),
    callToAction: Object.freeze({
      label: "Call to action",
      editableProps: Object.freeze(["eyebrow", "title", "body"]),
    }),
  } satisfies Readonly<Record<PageComponentType, ComponentRegistration>>),
});

export function createDefaultPageSection(
  type: PageComponentType,
  id: string,
): PageSection {
  switch (type) {
    case "hero":
      return {
        id,
        type,
        eyebrow: "Introduce this page",
        title: "A clear page headline",
        summary: "Explain the page in a short, useful sentence.",
        primaryAction: {
          id: `${id}_primary`,
          label: "Primary action",
          href: "#section_contact",
        },
        secondaryAction: {
          id: `${id}_secondary`,
          label: "Learn more",
          href: "#section_services",
        },
      };
    case "services":
      return {
        id,
        type,
        eyebrow: "Services",
        title: "What we can make together",
        introduction: "Describe the work available here.",
        items: [
          {
            id: `${id}_item`,
            number: "01",
            title: "A service",
            description: "Explain this service.",
          },
        ],
      };
    case "proof":
      return {
        id,
        type,
        quote: "Add a principle or a piece of evidence.",
        attribution: "Source",
        metrics: [
          {
            id: `${id}_metric`,
            value: "1",
            label: "Meaningful result",
          },
        ],
      };
    case "callToAction":
      return {
        id,
        type,
        eyebrow: "Next step",
        title: "Invite the reader to act",
        body: "Explain what will happen next.",
        action: {
          id: `${id}_action`,
          label: "Get in touch",
          href: "mailto:hello@example.com",
        },
      };
  }
}

export function toPageComposition(
  definition: SiteDefinition,
): PageComposition {
  return {
    slotId: pageCompositionContract.slot.id,
    components: definition.home.sections,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function referencedPageComponentIds(
  definition: SiteDefinition,
  sections: ReadonlyArray<PageSection> = definition.home.sections,
): ReadonlySet<string> {
  const referenced = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    for (const [key, nested] of Object.entries(value)) {
      if (
        key === "href" &&
        typeof nested === "string" &&
        /^#section_[a-z0-9_]+$/u.test(nested)
      ) {
        referenced.add(nested.slice(1));
      } else {
        visit(nested);
      }
    }
  };
  visit(definition.site);
  visit(sections);
  return referenced;
}

function protectedShape(
  section: PageSection,
  normalizeNestedIds = false,
): Record<string, unknown> {
  const registration = pageCompositionContract.components[section.type];
  const protectedSection = structuredClone(section) as unknown as Record<
    string,
    unknown
  >;
  delete protectedSection.id;
  for (const property of registration.editableProps) {
    delete protectedSection[property];
  }
  const normalizeProtectedShape = (
    value: unknown,
    root = false,
  ): unknown => {
    if (Array.isArray(value)) {
      return value.map((nested) => normalizeProtectedShape(nested));
    }
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value)
          .filter(
            ([key, nested]) =>
              root ||
              typeof nested !== "string" ||
              key === "id" ||
              key === "type" ||
              key === "href",
          )
          .map(([key, nested]) => [
            key,
            key === "id" && normalizeNestedIds
              ? "$stableId"
              : normalizeProtectedShape(nested),
          ]),
      );
    }
    return value;
  };
  return normalizeProtectedShape(protectedSection, true) as Record<
    string,
    unknown
  >;
}

function equalProtectedShape(
  left: PageSection,
  right: PageSection,
  normalizeNestedIds = false,
): boolean {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(canonicalize);
    }
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, canonicalize(nested)]),
      );
    }
    return value;
  };
  return (
    JSON.stringify(
      canonicalize(protectedShape(left, normalizeNestedIds)),
    ) ===
    JSON.stringify(
      canonicalize(protectedShape(right, normalizeNestedIds)),
    )
  );
}

function validateEditableProps(
  section: PageSection,
  errors: Record<string, string>,
): void {
  const registration = pageCompositionContract.components[section.type];
  const record = section as unknown as Record<string, unknown>;
  for (const property of registration.editableProps) {
    if (
      typeof record[property] !== "string" ||
      (record[property] as string).trim() === ""
    ) {
      errors[`${section.id}.${property}`] =
        "Enter at least one visible character.";
    }
  }
}

export function applyPageComposition(
  definition: SiteDefinition,
  value: unknown,
): PageCompositionResult {
  const errors = Object.create(null) as Record<string, string>;
  if (!isRecord(value) || value.slotId !== pageCompositionContract.slot.id) {
    const slotId =
      isRecord(value) && typeof value.slotId === "string"
        ? value.slotId
        : "slotId";
    errors[slotId] = "This slot is not registered by the Site Definition.";
    return { ok: false, errors };
  }
  if (!Array.isArray(value.components)) {
    return {
      ok: false,
      errors: {
        [pageCompositionContract.slot.id]:
          "Provide the registered components for this slot.",
      },
    };
  }
  if (
    value.components.length < pageCompositionContract.slot.minItems ||
    value.components.length > pageCompositionContract.slot.maxItems
  ) {
    errors[pageCompositionContract.slot.id] =
      `Use ${pageCompositionContract.slot.minItems}–${pageCompositionContract.slot.maxItems} components.`;
  }

  const existingById = new Map(
    definition.home.sections.map((section) => [section.id, section]),
  );
  const accepted: PageSection[] = [];
  const ids = new Set<string>();
  const nestedIds = new Set<string>();
  for (const candidate of value.components) {
    if (!isRecord(candidate)) {
      errors[pageCompositionContract.slot.id] =
        "Every slot item must be a registered component.";
      continue;
    }
    const id =
      typeof candidate.id === "string" ? candidate.id : "component";
    if (!/^section_[a-z0-9_]+$/u.test(id)) {
      errors[`${id}.id`] = "Use a stable section identifier.";
      continue;
    }
    if (ids.has(id)) {
      errors[`${id}.id`] = "Component identifiers must be unique in the slot.";
      continue;
    }
    ids.add(id);
    if (
      typeof candidate.type !== "string" ||
      !Object.hasOwn(pageCompositionContract.components, candidate.type)
    ) {
      errors[`${id}.type`] =
        "This component is not registered for the page slot.";
      continue;
    }
    const section = candidate as unknown as PageSection;
    const existing = existingById.get(id);
    if (existing !== undefined && existing.type !== section.type) {
      errors[`${id}.type`] =
        "An existing component cannot change its registered type.";
      continue;
    }
    const scaffoldAllowed =
      existing === undefined
        ? equalProtectedShape(
            createDefaultPageSection(section.type, id),
            section,
          ) ||
          definition.home.sections
            .filter((source) => source.type === section.type)
            .some((source) =>
              equalProtectedShape(source, section, true),
            )
        : equalProtectedShape(existing, section);
    if (!scaffoldAllowed) {
      const protectedProperty = Object.keys(protectedShape(section))[1] ?? "type";
      errors[`${id}.${protectedProperty}`] =
        "This component scaffolding is protected by the Site Definition.";
      continue;
    }
    const visitIds = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visitIds);
        return;
      }
      if (!isRecord(value)) {
        return;
      }
      for (const [key, nested] of Object.entries(value)) {
        if (key === "id") {
          if (
            typeof nested !== "string" ||
            !/^[a-z][a-z0-9_]*$/u.test(nested) ||
            nestedIds.has(nested)
          ) {
            errors[`${id}.id`] =
              "Every component and nested item needs a unique stable identifier.";
          } else {
            nestedIds.add(nested);
          }
        } else {
          visitIds(nested);
        }
      }
    };
    visitIds(section);
    validateEditableProps(section, errors);
    accepted.push(structuredClone(section));
  }
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  const acceptedIds = new Set(accepted.map(({ id }) => id));
  for (const referencedId of referencedPageComponentIds(
    definition,
    accepted,
  )) {
    if (!acceptedIds.has(referencedId)) {
      errors[`${referencedId}.id`] =
        "This component is referenced by protected page scaffolding.";
    }
  }
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  const next = structuredClone(definition) as unknown as {
    home: { sections: PageSection[] };
  };
  next.home.sections = accepted;
  return { ok: true, definition: next as unknown as SiteDefinition };
}
