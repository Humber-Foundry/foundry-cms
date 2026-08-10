import type {
  PageSection,
  RegisteredPageSection,
  SiteDefinition,
} from "./index";
import { isBaseSiteDefinition } from "./index";
import { designContract } from "./design-tokens";
import { RICH_TEXT_VERSION } from "./rich-text";

type TextField = Readonly<{
  control: "text" | "textarea" | "image" | "url";
  label: string;
  defaultValue: string;
}>;

type SelectField = Readonly<{
  control: "select";
  label: string;
  defaultValue: string;
  options: ReadonlyArray<Readonly<{ label: string; value: string }>>;
}>;

type ArrayField = Readonly<{
  control: "array";
  label: string;
  defaultValue: ReadonlyArray<Readonly<Record<string, string>>>;
  fields: Readonly<Record<string, TextField | SelectField>>;
  minItems?: number;
  maxItems?: number;
}>;

export type PageComponentField = TextField | SelectField | ArrayField;

type FieldValue<Field extends PageComponentField> =
  Field extends ArrayField
    ? ReadonlyArray<Readonly<Record<string, string>>>
    : string;

export type RegisteredPageComponentProps<
  Fields extends Readonly<Record<string, PageComponentField>>,
> = Readonly<{
  [Key in keyof Fields]: FieldValue<Fields[Key]>;
}>;

export type PageComponentValidation =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      errors: Readonly<Record<string, string>>;
    }>;

export type PageComponentRegistration = Readonly<{
  type: string;
  label: string;
  editableFields: ReadonlyArray<string>;
  fields: Readonly<Record<string, PageComponentField>>;
  createDefault(id: string, definition?: SiteDefinition): PageSection;
  validate(section: unknown): PageComponentValidation;
}>;

export type PageComponentRegistry = Readonly<{
  components: Readonly<Record<string, PageComponentRegistration>>;
  allowedComponents: ReadonlyArray<string>;
  keyFor(section: PageSection): string;
  createDefault(
    type: string,
    id: string,
    definition?: SiteDefinition,
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
  fields: Fields;
}>): PageComponentRegistration & Readonly<{
  type: Type;
  fields: Fields;
  createDefault(
    id: string,
    definition?: SiteDefinition,
  ): RegisteredPageSection & Readonly<{
    component: Type;
    props: RegisteredPageComponentProps<Fields>;
  }>;
}> {
  if (!/^[a-z][A-Za-z0-9]*$/u.test(input.type)) {
    throw new TypeError("page_component_type_invalid");
  }
  const editableFields = Object.freeze(Object.keys(input.fields));
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

function foundationRegistration(
  type: "hero" | "services" | "proof" | "callToAction",
  label: string,
  editableFields: ReadonlyArray<string>,
  createDefault: (id: string, definition?: SiteDefinition) => PageSection,
): PageComponentRegistration {
  return Object.freeze({
    type,
    label,
    editableFields: Object.freeze([...editableFields]),
    fields: Object.freeze({}),
    createDefault,
    validate(section) {
      return isRecord(section) && section.type === type
        ? { ok: true }
        : {
            ok: false,
            errors: { component: "This component is not registered for the page slot." },
          };
    },
  });
}

function foundationDefault(
  type: "hero" | "services" | "proof" | "callToAction",
  id: string,
  definition?: SiteDefinition,
): PageSection {
  const linkTo = (preferred?: string) => {
    const target =
      definition?.home.sections.find((section) => section.type === preferred) ??
      definition?.home.sections[0];
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
  const existing = definition?.home.sections.find((section) => section.type === "callToAction");
  const contact = definition?.site.navigation.find((link) => link.href.startsWith("mailto:"));
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

const foundationComponents = {
  hero: foundationRegistration("hero", "Hero", ["eyebrow", "title", "summary"], (id, definition) => foundationDefault("hero", id, definition)),
  services: foundationRegistration("services", "Services", ["eyebrow", "title", "introduction"], (id, definition) => foundationDefault("services", id, definition)),
  proof: foundationRegistration("proof", "Proof", ["quote", "attribution"], (id, definition) => foundationDefault("proof", id, definition)),
  callToAction: foundationRegistration("callToAction", "Call to action", ["eyebrow", "title", "body"], (id, definition) => foundationDefault("callToAction", id, definition)),
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
    createDefault(type: string, id: string, definition?: SiteDefinition) {
      const registration = frozen[type];
      if (registration === undefined) throw new TypeError("page_component_unregistered");
      return registration.createDefault(id, definition);
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

export function isSiteDefinitionWithPageComponents(
  value: unknown,
  registry: PageComponentRegistry = foundationPageComponentRegistry,
): value is SiteDefinition {
  return (
    isBaseSiteDefinition(value) &&
    value.home.sections.every((section) => registry.validate(section).ok)
  );
}
