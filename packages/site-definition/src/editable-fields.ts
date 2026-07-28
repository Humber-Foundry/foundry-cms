import {
  parseSerializedRichTextDocument,
  richTextDocumentHasVisibleText,
  serializeRichTextDocument,
  serializeRichTextToMarkdown,
  type ProofSection,
  type SerializedRichTextDocument,
  type ServicesSection,
  type SiteDefinition,
} from "./index";

export type SiteDefinitionEdit =
  | Readonly<{
      path: string;
      format?: "plainText";
      value: string;
    }>
  | Readonly<{
      path: string;
      format: "richText";
      value: SerializedRichTextDocument;
    }>;

type EditableSiteFieldBase = Readonly<{
  path: string;
  label: string;
  group: "Page" | "Navigation" | "Footer" | "SEO";
  multiline: boolean;
}>;

export type EditableSiteField =
  | (EditableSiteFieldBase &
      Readonly<{ format: "plainText"; value: string }>)
  | (EditableSiteFieldBase &
      Readonly<{
        format: "richText";
        value: SerializedRichTextDocument;
      }>);

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

export class DuplicateEditableSiteFieldPathError extends Error {
  readonly path: string;

  constructor(path: string) {
    super("duplicate_editable_site_field_path");
    this.name = "DuplicateEditableSiteFieldPathError";
    this.path = path;
  }
}

type EditableFieldBindingInput = Readonly<{
  path: string;
  label: string;
  group: EditableSiteField["group"];
  multiline?: boolean;
  write(definition: MutableSiteDefinition, value: string): void;
}>;

function fieldBinding(
  input: EditableFieldBindingInput &
    Readonly<{ format?: "plainText"; value: string }>,
): EditableFieldBinding;
function fieldBinding(
  input: EditableFieldBindingInput &
    Readonly<{ format: "richText"; value: SerializedRichTextDocument }>,
): EditableFieldBinding;
function fieldBinding({
  path,
  label,
  group,
  value,
  multiline = false,
  format = "plainText",
  write,
}: EditableFieldBindingInput &
  Readonly<{
    format?: EditableSiteField["format"];
    value: string | SerializedRichTextDocument;
  }>): EditableFieldBinding {
  return {
    field: { path, label, group, value, multiline, format } as EditableSiteField,
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
        fields.push(
          fieldBinding({
            path: `${section.id}.body`,
            label: "Call to action body",
            group: "Page",
            value: serializeRichTextDocument(section.body),
            multiline: true,
            format: "richText",
            write: (draft, value) => {
              const draftSection = draft.home.sections[
                sectionIndex
              ] as unknown as Record<string, unknown>;
              draftSection.body = parseSerializedRichTextDocument(value);
            },
          }),
        );
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

  const paths = new Set<string>();
  for (const binding of fields) {
    if (paths.has(binding.field.path)) {
      throw new DuplicateEditableSiteFieldPathError(binding.field.path);
    }
    paths.add(binding.field.path);
  }
  return fields;
}

export function listEditableSiteFields(
  definition: SiteDefinition,
): ReadonlyArray<EditableSiteField> {
  return editableFieldBindings(definition).map(({ field }) => field);
}

export type PublishedRichTextArtifact = Readonly<{
  fieldPath: string;
  filePath: `content/rich-text/${string}.md`;
  markdown: string;
}>;

export function serializeSiteDefinitionRichTextForPublication(
  definition: SiteDefinition,
): ReadonlyArray<PublishedRichTextArtifact> {
  return listEditableSiteFields(definition)
    .filter(
      (
        field,
      ): field is Extract<EditableSiteField, { format: "richText" }> =>
        field.format === "richText",
    )
    .map((field) => ({
      fieldPath: field.path,
      filePath: `content/rich-text/${field.path.replaceAll(".", "/")}.md`,
      markdown: serializeRichTextToMarkdown(
        parseSerializedRichTextDocument(field.value),
      ),
    }));
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
  if (
    (edit.format ?? "plainText") !== binding.field.format
  ) {
    return null;
  }
  const draft = structuredClone(
    definition,
  ) as unknown as MutableSiteDefinition;
  try {
    binding.write(draft, edit.value);
  } catch {
    return null;
  }
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
  const errors = Object.create(null) as Record<string, string>;
  for (const edit of edits) {
    if (!bindings.has(edit.path)) {
      errors[edit.path] =
        `This field is not in Site Definition ${definition.definitionVersion}.`;
    } else if (
      (edit.format ?? "plainText") !== bindings.get(edit.path)!.field.format
    ) {
      errors[edit.path] = "The field value format does not match its schema.";
    } else if (
      bindings.get(edit.path)!.field.format === "plainText" &&
      edit.value.trim() === ""
    ) {
      errors[edit.path] = "Enter at least one visible character.";
    } else if (bindings.get(edit.path)!.field.format === "richText") {
      try {
        const document = parseSerializedRichTextDocument(edit.value);
        if (!richTextDocumentHasVisibleText(document)) {
          errors[edit.path] = "Enter at least one visible character.";
        }
      } catch {
        errors[edit.path] =
          "Rich text is invalid or contains unsupported or unsafe content.";
      }
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
