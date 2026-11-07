import type {
  PageSection,
  RegisteredPageSection,
  SiteDefinition,
  SitePage,
} from "./index";
import { isBaseSiteDefinition } from "./index";
import { parseSiteHref } from "./site-href";
import { designContract } from "./design-tokens";
import {
  RICH_TEXT_VERSION,
  richTextDocumentHasVisibleText,
  validateRichTextDocument,
  type RichTextDocument,
} from "./rich-text";

type FieldOptions = Readonly<{
  editable?: boolean;
}>;

type TextField = FieldOptions & Readonly<{
  control: "text" | "textarea" | "image" | "url" | "siteHref";
  label: string;
  defaultValue: string;
}>;

type SelectField = FieldOptions & Readonly<{
  control: "select";
  label: string;
  defaultValue: string;
  options: ReadonlyArray<Readonly<{ label: string; value: string }>>;
}>;

type RichTextField = FieldOptions & Readonly<{
  control: "richText";
  label: string;
  defaultValue: RichTextDocument;
}>;

type ObjectField = FieldOptions & Readonly<{
  control: "object";
  label: string;
  defaultValue: Readonly<Record<string, unknown>>;
  fields: Readonly<Record<string, PageComponentField>>;
}>;

type ArrayField = FieldOptions & Readonly<{
  control: "array";
  label: string;
  defaultValue: ReadonlyArray<Readonly<Record<string, unknown>>>;
  fields: Readonly<Record<string, PageComponentField>>;
  minItems?: number;
  maxItems?: number;
}>;

export type PageComponentField =
  | TextField
  | SelectField
  | RichTextField
  | ObjectField
  | ArrayField;

type FieldValue<Field extends PageComponentField> =
  Field extends Readonly<{
    control: "array";
    fields: infer Nested extends Readonly<Record<string, PageComponentField>>;
  }>
    ? ReadonlyArray<Readonly<{
        [Key in keyof Nested]: FieldValue<Nested[Key]>;
      }>>
    : Field extends Readonly<{
        control: "object";
        fields: infer Nested extends Readonly<Record<string, PageComponentField>>;
      }>
      ? Readonly<{
          [Key in keyof Nested]: FieldValue<Nested[Key]>;
        }>
      : Field extends RichTextField
        ? RichTextDocument
        : string;

export type RegisteredPageComponentProps<
  Fields extends Readonly<Record<string, PageComponentField>>,
> = Readonly<{
  [Key in keyof Fields]: FieldValue<Fields[Key]>;
}>;

type ValidatedPageComponentField<Field extends PageComponentField> =
  Field extends Readonly<{
    control: "array";
    fields: infer Nested extends Readonly<Record<string, PageComponentField>>;
  }>
    ? Omit<Field, "fields" | "defaultValue"> & Readonly<{
        fields: ValidatedPageComponentFields<Nested>;
        defaultValue: ReadonlyArray<Readonly<{
          [Key in keyof Nested]: FieldValue<Nested[Key]>;
        }>>;
      }>
    : Field extends Readonly<{
        control: "object";
        fields: infer Nested extends Readonly<Record<string, PageComponentField>>;
      }>
      ? Omit<Field, "fields" | "defaultValue"> & Readonly<{
          fields: ValidatedPageComponentFields<Nested>;
          defaultValue: Readonly<{
            [Key in keyof Nested]: FieldValue<Nested[Key]>;
          }>;
        }>
      : Field;

type ValidatedPageComponentFields<
  Fields extends Readonly<Record<string, PageComponentField>>,
> = Readonly<{
  [Key in keyof Fields]: ValidatedPageComponentField<Fields[Key]>;
}>;

export type PageComponentValidation =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      errors: Readonly<Record<string, string>>;
    }>;

/**
 * Where a new section is being scaffolded: the whole draft, and the one page
 * the section is going onto.
 *
 * A default section links to another section of the page it lands on, so it
 * cannot be built from the draft alone. Naming the page here means a caller
 * cannot silently scaffold onto the home page while the owner is editing
 * another one. See ADR-0032.
 */
export type PageSectionContext = Readonly<{
  definition: SiteDefinition;
  page: SitePage;
}>;

export type PageComponentRegistration = Readonly<{
  type: string;
  label: string;
  editableFields: ReadonlyArray<string>;
  fields: Readonly<Record<string, PageComponentField>>;
  createDefault(id: string, context?: PageSectionContext): PageSection;
  validate(section: unknown): PageComponentValidation;
}>;

export type PageComponentRegistry = Readonly<{
  components: Readonly<Record<string, PageComponentRegistration>>;
  allowedComponents: ReadonlyArray<string>;
  keyFor(section: PageSection): string;
  createDefault(
    type: string,
    id: string,
    context?: PageSectionContext,
  ): PageSection;
  validate(section: unknown): PageComponentValidation;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pageComponentKey(value: unknown): string | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  return value.type === "registered" && typeof value.component === "string"
    ? value.component
    : value.type;
}

function validateSafeImage(value: string): boolean {
  return (
    /^\/[A-Za-z0-9][A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/u.test(value) ||
    /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?(?:\/[^\s]*)?$/u.test(value)
  );
}

function validateField(
  field: PageComponentField,
  value: unknown,
  path: string,
  errors: Record<string, string>,
): void {
  if (field.control === "richText") {
    try {
      const document = validateRichTextDocument(value as RichTextDocument);
      if (!richTextDocumentHasVisibleText(document)) {
        errors[path] = "Enter at least one visible character.";
      }
    } catch {
      errors[path] =
        "Provide supported, safe rich text in the versioned Site Definition format.";
    }
    return;
  }
  if (field.control === "object") {
    if (
      !isRecord(value) ||
      Object.keys(value).some((key) => !Object.hasOwn(field.fields, key)) ||
      Object.keys(field.fields).some((key) => !Object.hasOwn(value, key))
    ) {
      errors[path] = "Use only fields registered for this item.";
      return;
    }
    Object.entries(field.fields).forEach(([key, nested]) =>
      validateField(nested, value[key], `${path}.${key}`, errors),
    );
    return;
  }
  if (field.control === "array") {
    if (!Array.isArray(value)) {
      errors[path] = "Provide the registered item list.";
      return;
    }
    if (
      (field.minItems !== undefined && value.length < field.minItems) ||
      (field.maxItems !== undefined && value.length > field.maxItems)
    ) {
      errors[path] = "Use the registered number of items.";
      return;
    }
    value.forEach((item, index) => {
      const itemPath = `${path}.${index}`;
      if (
        !isRecord(item) ||
        Object.keys(item).some((key) => !Object.hasOwn(field.fields, key)) ||
        Object.keys(field.fields).some((key) => !Object.hasOwn(item, key))
      ) {
        errors[itemPath] = "Use only fields registered for this item.";
        return;
      }
      Object.entries(field.fields).forEach(([key, itemField]) =>
        validateField(itemField, item[key], `${itemPath}.${key}`, errors),
      );
    });
    return;
  }
  if (typeof value !== "string" || value.trim() === "") {
    errors[path] = "Enter at least one visible character.";
    return;
  }
  if (field.control === "image" && !validateSafeImage(value)) {
    errors[path] = "Use a safe site image path or HTTPS image URL.";
  } else if (
    // A "siteHref" field — a hero or call-to-action button's link — accepts
    // every `SiteHref` form `parseSiteHref` recognizes: #anchor, mailto:,
    // page:<id>, page:<id>#<anchor>, and blog. This is the same widened set
    // $defs/href accepts (ADR-0022); whether a `page:` id names a real page
    // is checked separately by `isBaseSiteDefinition`, the same as it is for
    // navigation. A "url" field is a different, narrower control — an
    // installation-registered component's own link, which stays #anchor,
    // mailto:, or an HTTPS address.
    field.control === "siteHref" &&
    parseSiteHref(value).kind === "unrecognized"
  ) {
    errors[path] = "Use a safe page, email, or HTTPS URL.";
  } else if (
    field.control === "url" &&
    !(
      /^#[a-z][a-z0-9_]*$/u.test(value) ||
      /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value) ||
      /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?(?:\/[^\s]*)?$/u.test(value)
    )
  ) {
    errors[path] = "Use a safe page, email, or HTTPS URL.";
  } else if (
    field.control === "select" &&
    !field.options.some((option) => option.value === value)
  ) {
    errors[path] = "Choose a value registered for this component.";
  }
}

export function createRegisteredPageComponent<
  const Type extends string,
  const Fields extends Readonly<Record<string, PageComponentField>>,
>(input: Readonly<{
  type: Type;
  label: string;
  fields: Fields & ValidatedPageComponentFields<Fields>;
}>): PageComponentRegistration & Readonly<{
  type: Type;
  fields: Fields;
  createDefault(
    id: string,
    context?: PageSectionContext,
  ): RegisteredPageSection & Readonly<{
    component: Type;
    props: RegisteredPageComponentProps<Fields>;
  }>;
}> {
  if (!/^[a-z][A-Za-z0-9]*$/u.test(input.type)) {
    throw new TypeError("page_component_type_invalid");
  }
  const editableFields = Object.freeze(
    Object.entries(input.fields)
      .filter(([, field]) => field.editable !== false)
      .map(([key]) => key),
  );
  const registration = {
    ...input,
    editableFields,
    createDefault(id: string) {
      return {
        id,
        type: "registered" as const,
        component: input.type,
        props: Object.fromEntries(
          Object.entries(input.fields).map(([key, field]) => [
            key,
            structuredClone(field.defaultValue),
          ]),
        ) as RegisteredPageComponentProps<Fields>,
      };
    },
    validate(section: unknown): PageComponentValidation {
      const errors = Object.create(null) as Record<string, string>;
      const id =
        isRecord(section) && typeof section.id === "string"
          ? section.id
          : "component";
      if (
        !isRecord(section) ||
        section.type !== "registered" ||
        section.component !== input.type ||
        typeof section.id !== "string" ||
        !/^[a-z][a-z0-9_]*$/u.test(section.id) ||
        !isRecord(section.props)
      ) {
        return {
          ok: false,
          errors: { [`${id}.type`]: "This component is not registered for the page slot." },
        };
      }
      const props = section.props as Record<string, unknown>;
      const actual = Object.keys(props);
      const expected = Object.keys(input.fields);
      if (
        actual.some((key) => !expected.includes(key)) ||
        expected.some((key) => !actual.includes(key))
      ) {
        errors[`${id}.props`] = "Use only fields registered by this component.";
      }
      Object.entries(input.fields).forEach(([key, field]) =>
        validateField(field, props[key], `${id}.props.${key}`, errors),
      );
      return Object.keys(errors).length === 0
        ? { ok: true }
        : { ok: false, errors };
    },
  };
  return Object.freeze(registration) as ReturnType<
    typeof createRegisteredPageComponent<Type, Fields>
  >;
}

export function mergePageComponentFieldEdit(
  field: PageComponentField,
  protectedValue: unknown,
  submittedValue: unknown,
): unknown {
  if (field.editable === false) return structuredClone(protectedValue);
  if (field.control === "object") {
    if (!isRecord(submittedValue)) return structuredClone(submittedValue);
    const protectedRecord = isRecord(protectedValue) ? protectedValue : {};
    return Object.fromEntries(
      Object.entries(field.fields).map(([key, nested]) => [
        key,
        mergePageComponentFieldEdit(
          nested,
          protectedRecord[key] ?? nested.defaultValue,
          submittedValue[key],
        ),
      ]),
    );
  }
  if (field.control === "array") {
    if (!Array.isArray(submittedValue)) return structuredClone(submittedValue);
    const protectedItems = Array.isArray(protectedValue) ? protectedValue : [];
    return submittedValue.map((item, index) => {
      if (!isRecord(item)) return structuredClone(item);
      const protectedItem = isRecord(protectedItems[index])
        ? protectedItems[index]
        : {};
      return Object.fromEntries(
        Object.entries(field.fields).map(([key, nested]) => [
          key,
          mergePageComponentFieldEdit(
            nested,
            protectedItem[key] ?? nested.defaultValue,
            item[key],
          ),
        ]),
      );
    });
  }
  return structuredClone(submittedValue);
}

function foundationRegistration(
  type: "hero" | "services" | "proof" | "callToAction",
  label: string,
  fields: Readonly<Record<string, PageComponentField>>,
  createDefault: (id: string, context?: PageSectionContext) => PageSection,
): PageComponentRegistration {
  return Object.freeze({
    type,
    label,
    editableFields: Object.freeze(
      Object.entries(fields)
        .filter(([, field]) => field.editable !== false)
        .map(([key]) => key),
    ),
    fields: Object.freeze({ ...fields }),
    createDefault,
    validate(section) {
      const errors = Object.create(null) as Record<string, string>;
      const id = isRecord(section) && typeof section.id === "string"
        ? section.id
        : "component";
      if (
        !isRecord(section) ||
        section.type !== type ||
        typeof section.id !== "string" ||
        !/^[a-z][a-z0-9_]*$/u.test(section.id)
      ) {
        return {
          ok: false,
          errors: { [`${id}.type`]: "This component is not registered for the page slot." },
        };
      }
      const actual = Object.keys(section);
      const expected = ["id", "type", ...Object.keys(fields)];
      if (
        actual.some((key) => !expected.includes(key)) ||
        expected.some((key) => !actual.includes(key))
      ) {
        errors[id] = "Use only fields registered by the Site Definition.";
      }
      Object.entries(fields).forEach(([key, field]) =>
        validateField(field, section[key], `${id}.${key}`, errors),
      );
      return Object.keys(errors).length === 0
        ? { ok: true }
        : { ok: false, errors };
    },
  });
}

function foundationDefault(
  type: "hero" | "services" | "proof" | "callToAction",
  id: string,
  context?: PageSectionContext,
): PageSection {
  // A default section links to a section of the page it is going onto, so the
  // anchor it builds always points at something on that same page.
  const sections = context === undefined ? [] : context.page.sections;
  const linkTo = (preferred?: string) => {
    const target =
      sections.find((section) => section.type === preferred) ?? sections[0];
    return target === undefined ? "mailto:hello@example.com" as const : `#${target.id}` as const;
  };
  if (type === "hero") {
    return {
      id, type, variant: designContract.variants.hero.values[0],
      eyebrow: "Introduce this page", title: "A clear page headline",
      summary: "Explain the page in a short, useful sentence.",
      primaryAction: { id: `${id}_primary`, label: "Primary action", href: linkTo("callToAction") },
      secondaryAction: { id: `${id}_secondary`, label: "Learn more", href: linkTo("services") },
    };
  }
  if (type === "services") {
    return {
      id, type, variant: designContract.variants.services.values[0],
      eyebrow: "Services", title: "What we can make together",
      introduction: "Describe the work available here.",
      items: [{ id: `${id}_item`, number: "01", title: "A service", description: "Explain this service." }],
    };
  }
  if (type === "proof") {
    return {
      id, type, variant: designContract.variants.proof.values[0],
      quote: "Add a principle or a piece of evidence.", attribution: "Source",
      metrics: [{ id: `${id}_metric`, value: "1", label: "Meaningful result" }],
    };
  }
  const existing = sections.find(
    (section) => section.type === "callToAction",
  );
  const contact = context?.definition.site.navigation.find((link) =>
    link.href.startsWith("mailto:"),
  );
  return {
    id, type, variant: designContract.variants.callToAction.values[0],
    eyebrow: "Next step", title: "Invite the reader to act",
    body: { version: RICH_TEXT_VERSION, type: "document", children: [{ type: "paragraph", children: [{ type: "text", text: "Explain what will happen next.", marks: [] }] }] },
    action: {
      id: `${id}_action`,
      label: existing?.type === "callToAction" ? existing.action.label : contact?.label ?? "Continue",
      href: existing?.type === "callToAction" ? existing.action.href : contact?.href ?? linkTo(),
    },
  };
}

const linkFields = {
  id: { control: "text", label: "Stable identifier", defaultValue: "action", editable: false },
  label: { control: "text", label: "Label", defaultValue: "Continue", editable: false },
  href: { control: "siteHref", label: "Destination", defaultValue: "mailto:hello@example.com", editable: false },
} as const;

/**
 * The contact form block.
 *
 * It is a foundation component, so every installation has a way to put a
 * working form on a page. The owner writes the heading, the sentence under it
 * and the button label. The fields themselves are fixed, because they are the
 * fields of the public form the installation declares, and the Messages inbox
 * reads them by their registered roles.
 *
 * `formId` names that declared form. It is not editable: pointing a block at a
 * form the site does not declare would send every message into nothing. It
 * uses the stable `registered` envelope, so no installation has to change the
 * Site Definition schema to get this block. See ADR-0044.
 */
export const contactFormComponent = createRegisteredPageComponent({
  type: "contactForm",
  label: "Contact form",
  fields: {
    formId: {
      control: "text",
      label: "Form",
      defaultValue: "contact",
      editable: false,
    },
    title: {
      control: "text",
      label: "Heading",
      defaultValue: "Send a message",
    },
    body: {
      control: "textarea",
      label: "Sentence under the heading",
      defaultValue:
        "Tell us what you need. Leave your email address and we will write back.",
    },
    actionLabel: {
      control: "text",
      label: "Button label",
      defaultValue: "Send message",
    },
  },
});

const foundationComponents = {
  hero: foundationRegistration("hero", "Hero", {
    variant: { control: "select", label: "Variant", defaultValue: designContract.variants.hero.values[0], options: designContract.variants.hero.values.map((value) => ({ label: value, value })), editable: false },
    eyebrow: { control: "text", label: "Eyebrow", defaultValue: "Introduce this page" },
    title: { control: "text", label: "Title", defaultValue: "A clear page headline" },
    summary: { control: "textarea", label: "Summary", defaultValue: "Explain the page in a short, useful sentence." },
    primaryAction: { control: "object", label: "Primary action", fields: linkFields, defaultValue: { id: "primary", label: "Primary action", href: "mailto:hello@example.com" }, editable: false },
    secondaryAction: { control: "object", label: "Secondary action", fields: linkFields, defaultValue: { id: "secondary", label: "Learn more", href: "mailto:hello@example.com" }, editable: false },
  }, (id, definition) => foundationDefault("hero", id, definition)),
  services: foundationRegistration("services", "Services", {
    variant: { control: "select", label: "Variant", defaultValue: designContract.variants.services.values[0], options: designContract.variants.services.values.map((value) => ({ label: value, value })), editable: false },
    eyebrow: { control: "text", label: "Eyebrow", defaultValue: "Services" },
    title: { control: "text", label: "Title", defaultValue: "What we can make together" },
    introduction: { control: "textarea", label: "Introduction", defaultValue: "Describe the work available here." },
    items: { control: "array", label: "Services", fields: {
      id: { control: "text", label: "Stable identifier", defaultValue: "item", editable: false },
      number: { control: "text", label: "Number", defaultValue: "01", editable: false },
      title: { control: "text", label: "Title", defaultValue: "A service", editable: false },
      description: { control: "textarea", label: "Description", defaultValue: "Explain this service.", editable: false },
    }, defaultValue: [{ id: "service", number: "01", title: "A service", description: "Explain this service." }], editable: false },
  }, (id, definition) => foundationDefault("services", id, definition)),
  proof: foundationRegistration("proof", "Proof", {
    variant: { control: "select", label: "Variant", defaultValue: designContract.variants.proof.values[0], options: designContract.variants.proof.values.map((value) => ({ label: value, value })), editable: false },
    quote: { control: "textarea", label: "Quote", defaultValue: "Add a principle or a piece of evidence." },
    attribution: { control: "text", label: "Attribution", defaultValue: "Source" },
    metrics: { control: "array", label: "Metrics", fields: {
      id: { control: "text", label: "Stable identifier", defaultValue: "metric", editable: false },
      value: { control: "text", label: "Value", defaultValue: "1", editable: false },
      label: { control: "text", label: "Label", defaultValue: "Meaningful result", editable: false },
    }, defaultValue: [{ id: "metric", value: "1", label: "Meaningful result" }], editable: false },
  }, (id, definition) => foundationDefault("proof", id, definition)),
  callToAction: foundationRegistration("callToAction", "Call to action", {
    variant: { control: "select", label: "Variant", defaultValue: designContract.variants.callToAction.values[0], options: designContract.variants.callToAction.values.map((value) => ({ label: value, value })), editable: false },
    eyebrow: { control: "text", label: "Eyebrow", defaultValue: "Next step" },
    title: { control: "text", label: "Title", defaultValue: "Invite the reader to act" },
    body: { control: "richText", label: "Body", defaultValue: { version: RICH_TEXT_VERSION, type: "document", children: [{ type: "paragraph", children: [{ type: "text", text: "Explain what will happen next.", marks: [] }] }] } },
    action: { control: "object", label: "Action", fields: linkFields, defaultValue: { id: "action", label: "Continue", href: "mailto:hello@example.com" }, editable: false },
  }, (id, definition) => foundationDefault("callToAction", id, definition)),
  contactForm: contactFormComponent,
};

function registryFromComponents(
  components: Readonly<Record<string, PageComponentRegistration>>,
): PageComponentRegistry {
  const frozen = Object.freeze({ ...components });
  return Object.freeze({
    components: frozen,
    allowedComponents: Object.freeze(Object.keys(frozen)),
    keyFor(section: PageSection) {
      return section.type === "registered" ? section.component : section.type;
    },
    createDefault(type: string, id: string, context?: PageSectionContext) {
      const registration = frozen[type];
      if (registration === undefined) throw new TypeError("page_component_unregistered");
      return registration.createDefault(id, context);
    },
    validate(section: unknown) {
      const key = pageComponentKey(section);
      const registration = key === null ? undefined : frozen[key];
      return registration === undefined
        ? { ok: false, errors: { component: "This component is not registered for the page slot." } }
        : registration.validate(section);
    },
  });
}

export const foundationPageComponentRegistry = registryFromComponents(
  foundationComponents,
);

export function createPageComponentRegistry(
  foundation: PageComponentRegistry,
  additions: ReadonlyArray<PageComponentRegistration>,
): PageComponentRegistry {
  const components = { ...foundation.components };
  for (const registration of additions) {
    if (Object.hasOwn(components, registration.type)) {
      throw new TypeError("page_component_type_duplicate");
    }
    components[registration.type] = registration;
  }
  return registryFromComponents(components);
}

export function createPageComponentRegistryFromRegistrations(
  registrations: ReadonlyArray<PageComponentRegistration>,
): PageComponentRegistry {
  const components: Record<string, PageComponentRegistration> = {};
  for (const registration of registrations) {
    if (Object.hasOwn(components, registration.type)) {
      throw new TypeError("page_component_type_duplicate");
    }
    components[registration.type] = registration;
  }
  return registryFromComponents(components);
}

export function isSiteDefinitionWithPageComponents(
  value: unknown,
  registry: PageComponentRegistry = foundationPageComponentRegistry,
): value is SiteDefinition {
  return (
    isBaseSiteDefinition(value) &&
    value.pages.every((page) =>
      page.sections.every((section) => registry.validate(section).ok),
    )
  );
}
