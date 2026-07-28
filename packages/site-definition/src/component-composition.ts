import type {
  PageSection,
  SiteDefinition,
  SiteHref,
} from "./index";
import { designContract } from "./design-tokens";

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
      editableProps: Object.freeze([
        "variant",
        "eyebrow",
        "title",
        "summary",
      ]),
    }),
    services: Object.freeze({
      label: "Services",
      editableProps: Object.freeze([
        "variant",
        "eyebrow",
        "title",
        "introduction",
      ]),
    }),
    proof: Object.freeze({
      label: "Proof",
      editableProps: Object.freeze(["variant", "quote", "attribution"]),
    }),
    callToAction: Object.freeze({
      label: "Call to action",
      editableProps: Object.freeze(["variant", "eyebrow", "title", "body"]),
    }),
  } satisfies Readonly<Record<PageComponentType, ComponentRegistration>>),
});

export function createDefaultPageSection(
  type: PageComponentType,
  id: string,
  definition?: SiteDefinition,
): PageSection {
  const existingCallToAction = definition?.home.sections.find(
    (section) => section.type === "callToAction",
  );
  const contactNavigation = definition?.site.navigation.find(
    (link) => link.href.startsWith("mailto:"),
  );
  const linkTo = (preferredType?: PageComponentType): SiteHref => {
    const target =
      definition?.home.sections.find(
        (section) => section.type === preferredType,
      ) ?? definition?.home.sections[0];
    return target === undefined
      ? "mailto:hello@example.com"
      : `#${target.id}`;
  };
  switch (type) {
    case "hero":
      return {
        id,
        type,
        variant: designContract.variants.hero.values[0],
        eyebrow: "Introduce this page",
        title: "A clear page headline",
        summary: "Explain the page in a short, useful sentence.",
        primaryAction: {
          id: `${id}_primary`,
          label: "Primary action",
          href: linkTo("callToAction"),
        },
        secondaryAction: {
          id: `${id}_secondary`,
          label: "Learn more",
          href: linkTo("services"),
        },
      };
    case "services":
      return {
        id,
        type,
        variant: designContract.variants.services.values[0],
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
        variant: designContract.variants.proof.values[0],
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
        variant: designContract.variants.callToAction.values[0],
        eyebrow: "Next step",
        title: "Invite the reader to act",
        body: "Explain what will happen next.",
        action: {
          id: `${id}_action`,
          label:
            existingCallToAction?.action.label ??
            contactNavigation?.label ??
            "Continue",
          href:
            existingCallToAction?.action.href ??
            contactNavigation?.href ??
            linkTo(),
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

export function toPageCompositionIdentity(
  definition: SiteDefinition,
): Readonly<{
  slotId: PageComposition["slotId"];
  components: ReadonlyArray<
    Readonly<{ id: string; type: PageComponentType }>
  >;
}> {
  return {
    slotId: pageCompositionContract.slot.id,
    components: definition.home.sections.map(({ id, type }) => ({
      id,
      type,
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

function validateTextFields(
  value: Record<string, unknown>,
  fields: ReadonlyArray<string>,
  path: string,
  errors: Record<string, string>,
): boolean {
  let valid = true;
  for (const field of fields) {
    if (
      typeof value[field] !== "string" ||
      (value[field] as string).trim() === ""
    ) {
      errors[`${path}.${field}`] = "Enter at least one visible character.";
      valid = false;
    }
  }
  return valid;
}

function validateLink(
  value: unknown,
  path: string,
  errors: Record<string, string>,
): boolean {
  if (!validateObjectKeys(value, ["id", "label", "href"], path, errors)) {
    return false;
  }
  const textValid = validateTextFields(value, ["id", "label"], path, errors);
  const hrefValid =
    typeof value.href === "string" &&
    (/^#[a-z][a-z0-9_]*$/u.test(value.href) ||
      /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.href));
  if (!hrefValid) {
    errors[`${path}.href`] = "Use a registered page anchor or email link.";
  }
  return textValid && hrefValid;
}

function validateItemArray(
  value: unknown,
  path: string,
  fields: ReadonlyArray<string>,
  errors: Record<string, string>,
): boolean {
  if (!Array.isArray(value)) {
    errors[path] = "Use the registered component item list.";
    return false;
  }
  let valid = true;
  value.forEach((item, index) => {
    const itemPath = `${path}.${index}`;
    if (!validateObjectKeys(item, fields, itemPath, errors)) {
      valid = false;
      return;
    }
    if (!validateTextFields(item, fields, itemPath, errors)) {
      valid = false;
    }
  });
  return valid;
}

function validateSectionSchema(
  section: Record<string, unknown>,
  type: PageComponentType,
  id: string,
  errors: Record<string, string>,
): boolean {
  const path = id;
  if (
    typeof section.variant !== "string" ||
    !designContract.variants[type].values.includes(section.variant as never)
  ) {
    errors[`${path}.variant`] =
      "Choose a variant registered for this component.";
    return false;
  }
  switch (type) {
    case "hero":
      return (
        validateObjectKeys(
          section,
          [
            "id",
            "type",
            "variant",
            "eyebrow",
            "title",
            "summary",
            "primaryAction",
            "secondaryAction",
          ],
          path,
          errors,
        ) &&
        validateTextFields(
          section,
          ["id", "type", "variant", "eyebrow", "title", "summary"],
          path,
          errors,
        ) &&
        validateLink(section.primaryAction, `${path}.primaryAction`, errors) &&
        validateLink(section.secondaryAction, `${path}.secondaryAction`, errors)
      );
    case "services":
      return (
        validateObjectKeys(
          section,
          [
            "id",
            "type",
            "variant",
            "eyebrow",
            "title",
            "introduction",
            "items",
          ],
          path,
          errors,
        ) &&
        validateTextFields(
          section,
          [
            "id",
            "type",
            "variant",
            "eyebrow",
            "title",
            "introduction",
          ],
          path,
          errors,
        ) &&
        validateItemArray(
          section.items,
          `${path}.items`,
          ["id", "number", "title", "description"],
          errors,
        )
      );
    case "proof":
      return (
        validateObjectKeys(
          section,
          [
            "id",
            "type",
            "variant",
            "quote",
            "attribution",
            "metrics",
          ],
          path,
          errors,
        ) &&
        validateTextFields(
          section,
          ["id", "type", "variant", "quote", "attribution"],
          path,
          errors,
        ) &&
        validateItemArray(
          section.metrics,
          `${path}.metrics`,
          ["id", "value", "label"],
          errors,
        )
      );
    case "callToAction":
      return (
        validateObjectKeys(
          section,
          [
            "id",
            "type",
            "variant",
            "eyebrow",
            "title",
            "body",
            "action",
          ],
          path,
          errors,
        ) &&
        validateTextFields(
          section,
          ["id", "type", "variant", "eyebrow", "title", "body"],
          path,
          errors,
        ) &&
        validateLink(section.action, `${path}.action`, errors)
      );
  }
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
    if (
      typeof candidate.type !== "string" ||
      !Object.hasOwn(pageCompositionContract.components, candidate.type)
    ) {
      errors[`${id}.type`] =
        "This component is not registered for the page slot.";
      continue;
    }
    const type = candidate.type as PageComponentType;
    if (!validateSectionSchema(candidate, type, id, errors)) {
      continue;
    }
    const section = candidate as unknown as PageSection;
    const existing = existingById.get(id);
    if (existing !== undefined && existing.type !== section.type) {
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
          createDefaultPageSection(section.type, id, definition),
          section,
        ) ||
        equalProtectedShape(
          createDefaultPageSection(section.type, id, submittedContext),
          section,
        )
      );
    const duplicateScaffold =
      existing === undefined &&
      hasCanonicalDuplicateIds(section) &&
      [...definition.home.sections, ...accepted]
        .filter((source) => source.type === section.type)
        .some((source) => equalProtectedShape(source, section, true));
    const scaffoldAllowed =
      existing === undefined
        ? defaultScaffold || duplicateScaffold
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
