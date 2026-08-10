import type {
  PageSection,
  SiteDefinition,
} from "./index";
import {
  foundationPageComponentRegistry,
  type PageComponentRegistry,
} from "./page-component-registry";

export type PageComponentType = Exclude<PageSection["type"], "registered">;

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
      editableProps: Object.freeze([
        "eyebrow",
        "title",
        "summary",
      ]),
    }),
    services: Object.freeze({
      label: "Services",
      editableProps: Object.freeze([
        "eyebrow",
        "title",
        "introduction",
      ]),
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
  type: string,
  id: string,
  definition?: SiteDefinition,
  registry: PageComponentRegistry = foundationPageComponentRegistry,
): PageSection {
  return registry.createDefault(type, id, definition);
}

export function toPageComposition(
  definition: SiteDefinition,
): PageComposition {
  return {
    slotId: pageCompositionContract.slot.id,
    components: definition.home.sections,
  };
}

export function toPageCompositionIdentity(
  definition: SiteDefinition,
  registry: PageComponentRegistry = foundationPageComponentRegistry,
): Readonly<{
  slotId: PageComposition["slotId"];
  components: ReadonlyArray<
    Readonly<{ id: string; type: string }>
  >;
}> {
  return {
    slotId: pageCompositionContract.slot.id,
    components: definition.home.sections.map((section) => ({
      id: section.id,
      type: registry.keyFor(section),
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateObjectKeys(
  value: unknown,
  expected: ReadonlyArray<string>,
  path: string,
  errors: Record<string, string>,
): value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== expected.length ||
    Object.keys(value).some((key) => !expected.includes(key))
  ) {
    errors[path] = "Use only fields registered by the Site Definition.";
    return false;
  }
  return true;
}

export function referencedPageComponentIds(
  definition: SiteDefinition,
  sections: ReadonlyArray<PageSection> = definition.home.sections,
): ReadonlySet<string> {
  const referenced = new Set<string>();
  const componentIds = new Set(
    definition.home.sections.map(({ id }) => id),
  );
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
        /^#[a-z][a-z0-9_]*$/u.test(nested) &&
        componentIds.has(nested.slice(1))
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
  registry: PageComponentRegistry,
  normalizeNestedIds = false,
  protectVariant = true,
): Record<string, unknown> {
  const registration = registry.components[registry.keyFor(section)]!;
  const protectedSection = structuredClone(section) as unknown as Record<
    string,
    unknown
  >;
  delete protectedSection.id;
  // Variants are owned by the outer controlled-design fields. Composition
  // submissions carry them for rendering, so the domain boundary must protect
  // them from stale or direct composition writes.
  if (!protectVariant) {
    delete protectedSection.variant;
  }
  if (section.type === "registered") {
    delete protectedSection.props;
  } else {
    for (const property of registration.editableFields) {
      delete protectedSection[property];
    }
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
  registry: PageComponentRegistry,
  normalizeNestedIds = false,
  protectVariant = true,
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
      canonicalize(
        protectedShape(left, registry, normalizeNestedIds, protectVariant),
      ),
    ) ===
    JSON.stringify(
      canonicalize(
        protectedShape(right, registry, normalizeNestedIds, protectVariant),
      ),
    )
  );
}

function nestedSectionRecords(
  section: PageSection,
): ReadonlyArray<{ id: string }> {
  switch (section.type) {
    case "hero":
      return [section.primaryAction, section.secondaryAction];
    case "services":
      return section.items;
    case "proof":
      return section.metrics;
    case "callToAction":
      return [section.action];
    case "registered":
      return [];
  }
}

export function remapPageSectionNestedIds(
  section: PageSection,
): PageSection {
  const remapped = structuredClone(section);
  nestedSectionRecords(remapped).forEach((record, index) => {
    (record as { id: string }).id = `${section.id}_item_${index + 1}`;
  });
  return remapped;
}

function hasCanonicalDuplicateIds(section: PageSection): boolean {
  return nestedSectionRecords(section).every(
    (record, index) =>
      record.id === `${section.id}_item_${index + 1}`,
  );
}

function validateEditableProps(
  section: PageSection,
  registry: PageComponentRegistry,
  errors: Record<string, string>,
): void {
  const validation = registry.validate(section);
  if (!validation.ok) Object.assign(errors, validation.errors);
}

export function applyPageComposition(
  definition: SiteDefinition,
  value: unknown,
  registry: PageComponentRegistry = foundationPageComponentRegistry,
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
  if (
    !validateObjectKeys(
      value,
      ["slotId", "components"],
      pageCompositionContract.slot.id,
      errors,
    )
  ) {
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
  const submittedIds = new Set(
    value.components.flatMap((candidate) =>
      isRecord(candidate) && typeof candidate.id === "string"
        ? [candidate.id]
        : [],
    ),
  );
  const accepted: PageSection[] = [];
  const ids = new Set<string>();
  const nestedIds = new Set<string>();
  const seedProtectedIds = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      entry.forEach(seedProtectedIds);
      return;
    }
    if (!isRecord(entry)) {
      return;
    }
    for (const [key, nested] of Object.entries(entry)) {
      if (key === "id" && typeof nested === "string") {
        nestedIds.add(nested);
      } else {
        seedProtectedIds(nested);
      }
    }
  };
  seedProtectedIds(definition.site);
  seedProtectedIds({ id: definition.home.id, seo: definition.home.seo });
  for (const candidate of value.components) {
    if (!isRecord(candidate)) {
      errors[pageCompositionContract.slot.id] =
        "Every slot item must be a registered component.";
      continue;
    }
    const id =
      typeof candidate.id === "string" ? candidate.id : "component";
    if (!/^[a-z][a-z0-9_]*$/u.test(id)) {
      errors[`${id}.id`] = "Use a stable section identifier.";
      continue;
    }
    if (ids.has(id)) {
      errors[`${id}.id`] = "Component identifiers must be unique in the slot.";
      continue;
    }
    ids.add(id);
    const componentKey =
      candidate.type === "registered" && typeof candidate.component === "string"
        ? candidate.component
        : typeof candidate.type === "string"
          ? candidate.type
          : null;
    if (componentKey === null || !Object.hasOwn(registry.components, componentKey)) {
      errors[`${id}.type`] =
        "This component is not registered for the page slot.";
      continue;
    }
    const componentValidation = registry.validate(candidate);
    if (!componentValidation.ok) {
      const validation = componentValidation;
      if (!validation.ok) Object.assign(errors, validation.errors);
      continue;
    }
    const section = candidate as unknown as PageSection;
    const existing = existingById.get(id);
    if (
      existing !== undefined &&
      registry.keyFor(existing) !== registry.keyFor(section)
    ) {
      errors[`${id}.type`] =
        "An existing component cannot change its registered type.";
      continue;
    }
    const submittedContextSections = [
      ...accepted,
      ...definition.home.sections.filter(
        ({ id: existingId }) =>
          submittedIds.has(existingId) &&
          !accepted.some(({ id: acceptedId }) => acceptedId === existingId),
      ),
    ];
    const submittedContext = {
      ...definition,
      home: {
        ...definition.home,
        sections: submittedContextSections,
      },
    } as SiteDefinition;
    const defaultScaffold =
      existing === undefined &&
      (
        equalProtectedShape(
          createDefaultPageSection(componentKey, id, definition, registry),
          section,
          registry,
          false,
          false,
        ) ||
        equalProtectedShape(
          createDefaultPageSection(componentKey, id, submittedContext, registry),
          section,
          registry,
          false,
          false,
        )
      );
    const duplicateScaffold =
      existing === undefined &&
      hasCanonicalDuplicateIds(section) &&
      [...definition.home.sections, ...accepted]
        .filter((source) => registry.keyFor(source) === componentKey)
        .some((source) =>
          equalProtectedShape(source, section, registry, true, false),
        );
    const scaffoldAllowed =
      existing === undefined
        ? defaultScaffold || duplicateScaffold
        : equalProtectedShape(existing, section, registry);
    if (!scaffoldAllowed) {
      const submittedProtected = protectedShape(section, registry);
      const protectedProperty =
        (existing === undefined
          ? undefined
          : Object.keys(submittedProtected).find((property) => {
              const existingValue = protectedShape(existing, registry)[property];
              const submittedValue = submittedProtected[property];
              return (
                JSON.stringify(existingValue) !==
                JSON.stringify(submittedValue)
              );
            })) ??
        Object.keys(submittedProtected).find(
          (property) => property !== "type" && property !== "variant",
        ) ??
        (Object.hasOwn(submittedProtected, "variant")
          ? "variant"
          : undefined) ??
        "type";
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
    validateEditableProps(section, registry, errors);
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
