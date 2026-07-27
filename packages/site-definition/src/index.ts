declare const siteIdBrand: unique symbol;

export type SiteId = string & {
  readonly [siteIdBrand]: "SiteId";
};

export function createSiteId(value: string): SiteId {
  if (!/^site_[a-z0-9_]+$/.test(value)) {
    throw new TypeError(
      `Site IDs must start with "site_" and contain lowercase letters, numbers, or underscores: ${value}`,
    );
  }

  return value as SiteId;
}

export type SiteHref = `#${string}` | `mailto:${string}`;

export type SiteLink = Readonly<{
  id: string;
  label: string;
  href: SiteHref;
}>;

export type HeroSection = Readonly<{
  id: string;
  type: "hero";
  eyebrow: string;
  title: string;
  summary: string;
  primaryAction: SiteLink;
  secondaryAction: SiteLink;
}>;

export type ServicesSection = Readonly<{
  id: string;
  type: "services";
  eyebrow: string;
  title: string;
  introduction: string;
  items: ReadonlyArray<
    Readonly<{
      id: string;
      number: string;
      title: string;
      description: string;
    }>
  >;
}>;

export type ProofSection = Readonly<{
  id: string;
  type: "proof";
  quote: string;
  attribution: string;
  metrics: ReadonlyArray<
    Readonly<{
      id: string;
      value: string;
      label: string;
    }>
  >;
}>;

export type CallToActionSection = Readonly<{
  id: string;
  type: "callToAction";
  eyebrow: string;
  title: string;
  body: string;
  action: SiteLink;
}>;

export type PageSection =
  | HeroSection
  | ServicesSection
  | ProofSection
  | CallToActionSection;

export type SiteDefinition = Readonly<{
  definitionVersion: "1.0.0";
  schemaVersion: "1.0.0";
  site: Readonly<{
    id: SiteId;
    name: string;
    description: string;
    navigation: ReadonlyArray<SiteLink>;
    footer: string;
  }>;
  home: Readonly<{
    id: string;
    seo: Readonly<{
      title: string;
      description: string;
    }>;
    sections: ReadonlyArray<PageSection>;
  }>;
}>;

export const siteDefinitionSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://foundrycms.dev/schemas/site-definition/1.0.0",
  title: "Foundry CMS Site Definition",
  type: "object",
  additionalProperties: false,
  required: ["definitionVersion", "schemaVersion", "site", "home"],
  properties: {
    definitionVersion: { const: "1.0.0" },
    schemaVersion: { const: "1.0.0" },
    site: {
      type: "object",
      additionalProperties: false,
      required: ["id", "name", "description", "navigation", "footer"],
      properties: {
        id: { $ref: "#/$defs/siteId" },
        name: { $ref: "#/$defs/text" },
        description: { $ref: "#/$defs/text" },
        navigation: {
          type: "array",
          items: { $ref: "#/$defs/link" },
        },
        footer: { $ref: "#/$defs/text" },
      },
    },
    home: {
      type: "object",
      additionalProperties: false,
      required: ["id", "seo", "sections"],
      properties: {
        id: { $ref: "#/$defs/id" },
        seo: {
          type: "object",
          additionalProperties: false,
          required: ["title", "description"],
          properties: {
            title: { $ref: "#/$defs/text" },
            description: { $ref: "#/$defs/text" },
          },
        },
        sections: {
          type: "array",
          items: {
            oneOf: [
              { $ref: "#/$defs/heroSection" },
              { $ref: "#/$defs/servicesSection" },
              { $ref: "#/$defs/proofSection" },
              { $ref: "#/$defs/callToActionSection" },
            ],
          },
        },
      },
    },
  },
  $defs: {
    id: {
      type: "string",
      pattern: "^[a-z][a-z0-9_]*$",
    },
    siteId: {
      type: "string",
      pattern: "^site_[a-z0-9_]+$",
    },
    text: {
      type: "string",
      minLength: 1,
    },
    link: {
      type: "object",
      additionalProperties: false,
      required: ["id", "label", "href"],
      properties: {
        id: { $ref: "#/$defs/id" },
        label: { $ref: "#/$defs/text" },
        href: { $ref: "#/$defs/href" },
      },
    },
    href: {
      type: "string",
      anyOf: [
        { pattern: "^#[a-z][a-z0-9_]*$" },
        { pattern: "^mailto:[^\\s@]+@[^\\s@]+\\.[^\\s@]+$" },
      ],
    },
    serviceItem: {
      type: "object",
      additionalProperties: false,
      required: ["id", "number", "title", "description"],
      properties: {
        id: { $ref: "#/$defs/id" },
        number: { $ref: "#/$defs/text" },
        title: { $ref: "#/$defs/text" },
        description: { $ref: "#/$defs/text" },
      },
    },
    metric: {
      type: "object",
      additionalProperties: false,
      required: ["id", "value", "label"],
      properties: {
        id: { $ref: "#/$defs/id" },
        value: { $ref: "#/$defs/text" },
        label: { $ref: "#/$defs/text" },
      },
    },
    heroSection: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "type",
        "eyebrow",
        "title",
        "summary",
        "primaryAction",
        "secondaryAction",
      ],
      properties: {
        id: { $ref: "#/$defs/id" },
        type: { const: "hero" },
        eyebrow: { $ref: "#/$defs/text" },
        title: { $ref: "#/$defs/text" },
        summary: { $ref: "#/$defs/text" },
        primaryAction: { $ref: "#/$defs/link" },
        secondaryAction: { $ref: "#/$defs/link" },
      },
    },
    servicesSection: {
      type: "object",
      additionalProperties: false,
      required: ["id", "type", "eyebrow", "title", "introduction", "items"],
      properties: {
        id: { $ref: "#/$defs/id" },
        type: { const: "services" },
        eyebrow: { $ref: "#/$defs/text" },
        title: { $ref: "#/$defs/text" },
        introduction: { $ref: "#/$defs/text" },
        items: {
          type: "array",
          items: { $ref: "#/$defs/serviceItem" },
        },
      },
    },
    proofSection: {
      type: "object",
      additionalProperties: false,
      required: ["id", "type", "quote", "attribution", "metrics"],
      properties: {
        id: { $ref: "#/$defs/id" },
        type: { const: "proof" },
        quote: { $ref: "#/$defs/text" },
        attribution: { $ref: "#/$defs/text" },
        metrics: {
          type: "array",
          items: { $ref: "#/$defs/metric" },
        },
      },
    },
    callToActionSection: {
      type: "object",
      additionalProperties: false,
      required: ["id", "type", "eyebrow", "title", "body", "action"],
      properties: {
        id: { $ref: "#/$defs/id" },
        type: { const: "callToAction" },
        eyebrow: { $ref: "#/$defs/text" },
        title: { $ref: "#/$defs/text" },
        body: { $ref: "#/$defs/text" },
        action: { $ref: "#/$defs/link" },
      },
    },
  },
} as const;

export const referenceSiteDefinition = {
  definitionVersion: "1.0.0",
  schemaVersion: "1.0.0",
  site: {
    id: createSiteId("site_foundry_reference"),
    name: "Foundry Reference",
    description:
      "A representative, client-neutral site powered by a versioned Foundry Site Definition.",
    navigation: [
      {
        id: "nav_work",
        label: "What we make",
        href: "#section_services",
      },
      {
        id: "nav_approach",
        label: "How it works",
        href: "#section_proof",
      },
      {
        id: "nav_contact",
        label: "Start a project",
        href: "#section_contact",
      },
    ],
    footer:
      "An executable Foundry CMS reference installation, built for client ownership.",
  },
  home: {
    id: "page_home",
    seo: {
      title: "Foundry Reference — Independent work, thoughtfully made",
      description:
        "See a representative public site rendered from Foundry CMS’s versioned Site Definition.",
    },
    sections: [
      {
        id: "section_hero",
        type: "hero",
        eyebrow: "Independent work, thoughtfully made",
        title: "Turn a good idea into something people can use.",
        summary:
          "Foundry brings structure to the fuzzy middle—shaping clear digital products, useful identities, and durable publishing systems.",
        primaryAction: {
          id: "action_start",
          label: "Start a conversation",
          href: "#section_contact",
        },
        secondaryAction: {
          id: "action_explore",
          label: "Explore the approach",
          href: "#section_proof",
        },
      },
      {
        id: "section_services",
        type: "services",
        eyebrow: "A practical studio model",
        title: "From first sketch to a working system.",
        introduction:
          "Small teams do their best work when strategy, design, and engineering stay in the same conversation.",
        items: [
          {
            id: "service_shape",
            number: "01",
            title: "Shape the opportunity",
            description:
              "Clarify the audience, the job to be done, and the smallest useful version worth making.",
          },
          {
            id: "service_design",
            number: "02",
            title: "Design the experience",
            description:
              "Create an accessible visual system with a clear hierarchy and a calm path through the work.",
          },
          {
            id: "service_build",
            number: "03",
            title: "Build for ownership",
            description:
              "Deliver maintainable software and content tools that remain useful after handoff.",
          },
        ],
      },
      {
        id: "section_proof",
        type: "proof",
        quote:
          "The best handoff is not a folder of files. It is a system the next person can understand, operate, and trust.",
        attribution: "The Foundry principle",
        metrics: [
          { id: "metric_source", value: "1", label: "Shared content source" },
          { id: "metric_schema", value: "100%", label: "Schema-bound output" },
          { id: "metric_control", value: "0", label: "Vendor control planes" },
        ],
      },
      {
        id: "section_contact",
        type: "callToAction",
        eyebrow: "Begin with the real question",
        title: "What should exist when this work is done?",
        body:
          "Bring the rough notes, the constraints, and the thing that still feels unresolved. That is enough to start.",
        action: {
          id: "action_email",
          label: "Write the first note",
          href: "mailto:hello@example.com",
        },
      },
    ],
  },
} as const satisfies SiteDefinition;

export type SiteDefinitionEdit = Readonly<{
  path: string;
  value: string;
}>;

export type EditableSiteField = Readonly<{
  path: string;
  label: string;
  group: "Page" | "Navigation" | "Footer" | "SEO";
  value: string;
  multiline: boolean;
}>;

export type SiteDefinitionEditResult =
  | Readonly<{ ok: true; definition: SiteDefinition }>
  | Readonly<{
      ok: false;
      errors: Readonly<Record<string, string>>;
    }>;

type DeepMutable<Value> = Value extends string | number | boolean | bigint | symbol
  ? Value
  : Value extends ReadonlyArray<infer Item>
  ? DeepMutable<Item>[]
  : Value extends object
    ? { -readonly [Key in keyof Value]: DeepMutable<Value[Key]> }
    : Value;

type MutableSiteDefinition = DeepMutable<SiteDefinition>;

type EditableFieldBinding = Readonly<{
  field: EditableSiteField;
  write(definition: MutableSiteDefinition, value: string): void;
}>;

function fieldBinding({
  path,
  label,
  group,
  value,
  multiline = false,
  write,
}: EditableSiteField & {
  write(definition: MutableSiteDefinition, value: string): void;
}): EditableFieldBinding {
  return {
    field: { path, label, group, value, multiline },
    write,
  };
}

function editableFieldBindings(
  definition: SiteDefinition,
): EditableFieldBinding[] {
  const fields: EditableFieldBinding[] = [
    fieldBinding({
      path: `${definition.site.id}.name`,
      label: "Site name",
      group: "Page",
      value: definition.site.name,
      multiline: false,
      write: (draft, value) => {
        draft.site.name = value;
      },
    }),
    fieldBinding({
      path: `${definition.site.id}.description`,
      label: "Site description",
      group: "Page",
      value: definition.site.description,
      multiline: true,
      write: (draft, value) => {
        draft.site.description = value;
      },
    }),
    fieldBinding({
      path: `${definition.site.id}.footer`,
      label: "Footer",
      group: "Footer",
      value: definition.site.footer,
      multiline: true,
      write: (draft, value) => {
        draft.site.footer = value;
      },
    }),
    fieldBinding({
      path: `${definition.home.id}.seo.title`,
      label: "SEO title",
      group: "SEO",
      value: definition.home.seo.title,
      multiline: false,
      write: (draft, value) => {
        draft.home.seo.title = value;
      },
    }),
    fieldBinding({
      path: `${definition.home.id}.seo.description`,
      label: "SEO description",
      group: "SEO",
      value: definition.home.seo.description,
      multiline: true,
      write: (draft, value) => {
        draft.home.seo.description = value;
      },
    }),
  ];

  definition.site.navigation.forEach((item, index) => {
    fields.push(
      fieldBinding({
        path: `${item.id}.label`,
        label: `Navigation: ${item.label}`,
        group: "Navigation",
        value: item.label,
        multiline: false,
        write: (draft, value) => {
          draft.site.navigation[index]!.label = value;
        },
      }),
    );
  });

  definition.home.sections.forEach((section, sectionIndex) => {
    const bindSectionField = (
      property: string,
      label: string,
      value: string,
      multiline = false,
    ) => {
      fields.push(
        fieldBinding({
          path: `${section.id}.${property}`,
          label,
          group: "Page",
          value,
          multiline,
          write: (draft, nextValue) => {
            const draftSection = draft.home.sections[
              sectionIndex
            ] as unknown as Record<string, unknown>;
            draftSection[property] = nextValue;
          },
        }),
      );
    };
    const bindNestedLabel = (
      itemId: string,
      label: string,
      value: string,
      write: (draftSection: Record<string, any>, value: string) => void,
    ) => {
      fields.push(
        fieldBinding({
          path: `${itemId}.label`,
          label,
          group: "Page",
          value,
          multiline: false,
          write: (draft, nextValue) => {
            write(
              draft.home.sections[sectionIndex] as unknown as Record<
                string,
                any
              >,
              nextValue,
            );
          },
        }),
      );
    };

    switch (section.type) {
      case "hero":
        bindSectionField("eyebrow", "Hero eyebrow", section.eyebrow);
        bindSectionField("title", "Hero title", section.title);
        bindSectionField("summary", "Hero summary", section.summary, true);
        bindNestedLabel(
          section.primaryAction.id,
          "Hero primary action",
          section.primaryAction.label,
          (draftSection, value) => {
            draftSection.primaryAction.label = value;
          },
        );
        bindNestedLabel(
          section.secondaryAction.id,
          "Hero secondary action",
          section.secondaryAction.label,
          (draftSection, value) => {
            draftSection.secondaryAction.label = value;
          },
        );
        break;
      case "services":
        bindSectionField("eyebrow", "Services eyebrow", section.eyebrow);
        bindSectionField("title", "Services title", section.title);
        bindSectionField(
          "introduction",
          "Services introduction",
          section.introduction,
          true,
        );
        section.items.forEach((item, itemIndex) => {
          for (const [property, label, multiline] of [
            ["number", "Service number", false],
            ["title", "Service title", false],
            ["description", "Service description", true],
          ] as const) {
            fields.push(
              fieldBinding({
                path: `${item.id}.${property}`,
                label,
                group: "Page",
                value: item[property],
                multiline,
                write: (draft, nextValue) => {
                  const draftSection = draft.home.sections[
                    sectionIndex
                  ] as ServicesSection;
                  (
                    draftSection.items[itemIndex] as unknown as Record<
                      string,
                      string
                    >
                  )[property] = nextValue;
                },
              }),
            );
          }
        });
        break;
      case "proof":
        bindSectionField("quote", "Proof quote", section.quote, true);
        bindSectionField(
          "attribution",
          "Proof attribution",
          section.attribution,
        );
        section.metrics.forEach((metric, metricIndex) => {
          for (const [property, label] of [
            ["value", "Metric value"],
            ["label", "Metric label"],
          ] as const) {
            fields.push(
              fieldBinding({
                path: `${metric.id}.${property}`,
                label,
                group: "Page",
                value: metric[property],
                multiline: false,
                write: (draft, nextValue) => {
                  const draftSection = draft.home.sections[
                    sectionIndex
                  ] as ProofSection;
                  (
                    draftSection.metrics[metricIndex] as unknown as Record<
                      string,
                      string
                    >
                  )[property] = nextValue;
                },
              }),
            );
          }
        });
        break;
      case "callToAction":
        bindSectionField("eyebrow", "Call to action eyebrow", section.eyebrow);
        bindSectionField("title", "Call to action title", section.title);
        bindSectionField("body", "Call to action body", section.body, true);
        bindNestedLabel(
          section.action.id,
          "Call to action label",
          section.action.label,
          (draftSection, value) => {
            draftSection.action.label = value;
          },
        );
        break;
    }
  });

  return fields;
}

export function listEditableSiteFields(
  definition: SiteDefinition,
): ReadonlyArray<EditableSiteField> {
  return editableFieldBindings(definition).map(({ field }) => field);
}

export function updateEditableSiteField(
  definition: SiteDefinition,
  edit: SiteDefinitionEdit,
): SiteDefinition | null {
  const binding = editableFieldBindings(definition).find(
    ({ field }) => field.path === edit.path,
  );
  if (binding === undefined) {
    return null;
  }
  const draft = structuredClone(
    definition,
  ) as unknown as MutableSiteDefinition;
  binding.write(draft, edit.value);
  return draft as unknown as SiteDefinition;
}

export function applySiteDefinitionEdits(
  definition: SiteDefinition,
  edits: ReadonlyArray<SiteDefinitionEdit>,
): SiteDefinitionEditResult {
  const bindings = new Map(
    editableFieldBindings(definition).map((binding) => [
      binding.field.path,
      binding,
    ]),
  );
  const errors: Record<string, string> = {};
  for (const edit of edits) {
    if (!bindings.has(edit.path)) {
      errors[edit.path] =
        `This field is not in Site Definition ${definition.definitionVersion}.`;
    } else if (edit.value.trim() === "") {
      errors[edit.path] = "Enter at least one visible character.";
    }
  }
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  const draft = structuredClone(
    definition,
  ) as unknown as MutableSiteDefinition;
  for (const edit of edits) {
    bindings.get(edit.path)!.write(draft, edit.value);
  }
  return {
    ok: true,
    definition: draft as unknown as SiteDefinition,
  };
}
