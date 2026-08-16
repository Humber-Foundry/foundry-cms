import {
  parseSerializedRichTextDocument,
  richTextDocumentHasVisibleText,
  isSiteDefinition,
  serializeRichTextDocument,
  serializeRichTextToMarkdown,
  type ProofSection,
  type BlogPostId,
  type SeoMetadata,
  type SerializedRichTextDocument,
  type ServicesSection,
  type SiteDefinition,
} from "./index";
import { designContract } from "./design-tokens";
import {
  normalizeCanonicalOrigin,
  seoFieldHints,
  seoKeywordLimit,
} from "./seo";

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
  group: "Page" | "Navigation" | "Footer" | "SEO" | "Design" | "Blog";
  multiline: boolean;
  values?: ReadonlyArray<string>;
  /**
   * `true` when the owner may leave this field blank. A blank optional field
   * is not an error; it asks the renderer for its fallback.
   */
  optional: boolean;
  /** One short line telling the owner what happens when they leave it blank. */
  hint?: string;
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
  blogPostId?: BlogPostId;
  /**
   * A rule this one field enforces beyond its schema, returning the sentence
   * to show the owner or `null` when the value is good. It exists so a field
   * with a real limit can say what the limit is, instead of falling through to
   * the generic schema-mismatch message.
   */
  validate?(value: string): string | null;
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
  values?: ReadonlyArray<string>;
  optional?: boolean;
  hint?: string;
  blogPostId?: BlogPostId;
  validate?(value: string): string | null;
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
  values,
  optional = false,
  hint,
  blogPostId,
  validate,
  write,
}: EditableFieldBindingInput &
  Readonly<{
    format?: EditableSiteField["format"];
    value: string | SerializedRichTextDocument;
  }>): EditableFieldBinding {
  return {
    field: {
      path,
      label,
      group,
      value,
      multiline,
      format,
      optional,
      ...(values === undefined ? {} : { values }),
      ...(hint === undefined ? {} : { hint }),
    } as EditableSiteField,
    ...(blogPostId === undefined ? {} : { blogPostId }),
    ...(validate === undefined ? {} : { validate }),
    write,
  };
}

/**
 * Drop any share image left without an address.
 *
 * The two share-image fields are written one at a time, so a draft can hold an
 * alt text that has no address yet. Run this once every edit in a batch has
 * been written: an image with no address is no image.
 */
function normalizeSeoShareImages(draft: MutableSiteDefinition): void {
  const seoBlocks = [draft.home.seo, ...draft.blog.posts.map(({ seo }) => seo)];
  for (const seo of seoBlocks) {
    if (seo.shareImage !== null && seo.shareImage.url.trim() === "") {
      seo.shareImage = null;
    }
  }
}

/**
 * Read a comma-separated keyword list the way an owner types it.
 * Blank entries and repeats are dropped, so "boats, , boats" becomes
 * one keyword.
 */
export function parseSeoKeywords(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((keyword) => keyword.trim())
        .filter((keyword) => keyword !== ""),
    ),
  ];
}

/** Show a keyword list back to the owner in the form they typed it. */
export function formatSeoKeywords(
  keywords: ReadonlyArray<string>,
): string {
  return keywords.join(", ");
}

function editableFieldBindings(
  definition: SiteDefinition,
): EditableFieldBinding[] {
  /**
   * The one SEO and sharing field set, bound for whichever surface asks.
   * The home page and every blog post get identical fields, so an owner
   * learns the panel once and a drafting agent has one target.
   */
  const seoFieldBindings = ({
    pathPrefix,
    labelPrefix,
    group,
    seo,
    titleHint,
    descriptionHint,
    blogPostId,
    select,
  }: {
    pathPrefix: string;
    labelPrefix: string;
    group: EditableSiteField["group"];
    seo: SeoMetadata;
    titleHint: string;
    descriptionHint: string;
    blogPostId?: BlogPostId;
    select(draft: MutableSiteDefinition): DeepMutable<SeoMetadata>;
  }): EditableFieldBinding[] => {
    const shared = { group, ...(blogPostId === undefined ? {} : { blogPostId }) };
    /**
     * A share image is one thing to an owner and two fields on screen. Each
     * field writes its own part and leaves the other alone, so the pair
     * survives whichever order the two edits arrive in. An address-less pair
     * is dropped afterwards by `normalizeSeoShareImages`, not here, because
     * dropping it here would discard alt text that a later edit is about to
     * pair with an address.
     */
    const writeShareImage = (
      draft: MutableSiteDefinition,
      part: "url" | "alt",
      value: string,
    ) => {
      const target = select(draft);
      target.shareImage = {
        ...(target.shareImage ?? { url: "", alt: "" }),
        [part]: value.trim(),
      };
    };
    return [
      fieldBinding({
        ...shared,
        path: `${pathPrefix}.seo.title`,
        label: `${labelPrefix} SEO title`,
        value: seo.title,
        multiline: false,
        optional: true,
        hint: titleHint,
        write: (draft, value) => {
          select(draft).title = value;
        },
      }),
      fieldBinding({
        ...shared,
        path: `${pathPrefix}.seo.description`,
        label: `${labelPrefix} SEO description`,
        value: seo.description,
        multiline: true,
        optional: true,
        hint: descriptionHint,
        write: (draft, value) => {
          select(draft).description = value;
        },
      }),
      fieldBinding({
        ...shared,
        path: `${pathPrefix}.seo.keywords`,
        label: `${labelPrefix} keywords`,
        value: formatSeoKeywords(seo.keywords),
        multiline: false,
        optional: true,
        hint: seoFieldHints.keywords,
        // The schema caps the list too, but a schema failure reads as "the
        // field value format does not match its schema". An owner who typed
        // one keyword too many deserves to be told that.
        validate: (value) =>
          parseSeoKeywords(value).length > seoKeywordLimit
            ? seoFieldHints.tooManyKeywords
            : null,
        write: (draft, value) => {
          select(draft).keywords = parseSeoKeywords(value);
        },
      }),
      fieldBinding({
        ...shared,
        path: `${pathPrefix}.seo.shareImage.url`,
        label: `${labelPrefix} share image address`,
        value: seo.shareImage?.url ?? "",
        multiline: false,
        optional: true,
        hint: seoFieldHints.shareImageUrl,
        write: (draft, value) => {
          writeShareImage(draft, "url", value);
        },
      }),
      fieldBinding({
        ...shared,
        path: `${pathPrefix}.seo.shareImage.alt`,
        label: `${labelPrefix} share image description`,
        value: seo.shareImage?.alt ?? "",
        multiline: false,
        optional: true,
        hint: seoFieldHints.shareImageAlt,
        write: (draft, value) => {
          writeShareImage(draft, "alt", value);
        },
      }),
    ];
  };
  const designTokenBinding = ({
    path,
    label,
    value,
    values,
    write,
  }: {
    path: string;
    label: string;
    value: string;
    values: ReadonlyArray<string>;
    write(definition: MutableSiteDefinition, value: string): void;
  }) =>
    fieldBinding({
      path,
      label,
      group: "Design",
      value,
      multiline: false,
      values,
      write,
    });
  const fields: EditableFieldBinding[] = [
    designTokenBinding({
      path: "design.typography.heading",
      label: designContract.tokens["typography.heading"].label,
      value: definition.design.typography.heading,
      values: designContract.tokens["typography.heading"].values,
      write: (draft, value) => {
        draft.design.typography.heading =
          value as SiteDefinition["design"]["typography"]["heading"];
      },
    }),
    designTokenBinding({
      path: "design.colour.accent",
      label: designContract.tokens["colour.accent"].label,
      value: definition.design.colour.accent,
      values: designContract.tokens["colour.accent"].values,
      write: (draft, value) => {
        draft.design.colour.accent =
          value as SiteDefinition["design"]["colour"]["accent"];
      },
    }),
    designTokenBinding({
      path: "design.spacing.section",
      label: designContract.tokens["spacing.section"].label,
      value: definition.design.spacing.section,
      values: designContract.tokens["spacing.section"].values,
      write: (draft, value) => {
        draft.design.spacing.section =
          value as SiteDefinition["design"]["spacing"]["section"];
      },
    }),
    designTokenBinding({
      path: "design.layout.contentWidth",
      label: designContract.tokens["layout.contentWidth"].label,
      value: definition.design.layout.contentWidth,
      values: designContract.tokens["layout.contentWidth"].values,
      write: (draft, value) => {
        draft.design.layout.contentWidth =
          value as SiteDefinition["design"]["layout"]["contentWidth"];
      },
    }),
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
      path: `${definition.site.id}.canonicalOrigin`,
      label: "Site address",
      group: "SEO",
      value: definition.site.canonicalOrigin,
      multiline: false,
      optional: true,
      hint: seoFieldHints.siteAddress,
      write: (draft, value) => {
        draft.site.canonicalOrigin = normalizeCanonicalOrigin(value);
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
    ...seoFieldBindings({
      pathPrefix: definition.home.id,
      labelPrefix: "Page",
      group: "SEO",
      seo: definition.home.seo,
      titleHint: seoFieldHints.page.title,
      descriptionHint: seoFieldHints.page.description,
      select: (draft) => draft.home.seo,
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
    if (section.type === "registered") return;
    const variant = designContract.variants[section.type];
    fields.push(
      fieldBinding({
        path: `${section.id}.variant`,
        label: variant.label,
        group: "Design",
        value: section.variant,
        multiline: false,
        values: variant.values,
        write: (draft, value) => {
          const draftSection = draft.home.sections[
            sectionIndex
          ] as unknown as Record<string, unknown>;
          draftSection.variant = value;
        },
      }),
    );
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

  definition.blog.posts.forEach((post, postIndex) => {
    const bindPostField = (
      property: "slug" | "title" | "excerpt",
      label: string,
      multiline = false,
    ) => {
      fields.push(
        fieldBinding({
          path: `${post.id}.${property}`,
          blogPostId: post.id,
          label,
          group: "Blog",
          value: post[property],
          multiline,
          write: (draft, value) => {
            draft.blog.posts[postIndex]![property] = value;
          },
        }),
      );
    };
    bindPostField("slug", "Post slug");
    bindPostField("title", "Post title");
    bindPostField("excerpt", "Post excerpt", true);
    fields.push(
      ...seoFieldBindings({
        pathPrefix: post.id,
        labelPrefix: "Post",
        group: "Blog",
        seo: post.seo,
        blogPostId: post.id,
        titleHint: seoFieldHints.post.title,
        descriptionHint: seoFieldHints.post.description,
        select: (draft) => draft.blog.posts[postIndex]!.seo,
      }),
    );
    fields.push(
      fieldBinding({
        path: `${post.id}.body`,
        blogPostId: post.id,
        label: "Post body",
        group: "Blog",
        value: serializeRichTextDocument(post.body),
        multiline: true,
        format: "richText",
        write: (draft, value) => {
          (
            draft.blog.posts[postIndex] as unknown as Record<string, unknown>
          ).body = parseSerializedRichTextDocument(value);
        },
      }),
    );
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
  const publicPostIds = new Set(
    definition.blog.posts
      .filter(({ targetVisibility }) => targetVisibility === "public")
      .map(({ id }) => id),
  );
  return editableFieldBindings(definition)
    .filter(
      (
        binding,
      ): binding is EditableFieldBinding & {
        field: Extract<EditableSiteField, { format: "richText" }>;
      } =>
        binding.field.format === "richText" &&
        (binding.field.group !== "Blog" ||
          (binding.blogPostId !== undefined &&
            publicPostIds.has(binding.blogPostId))),
    )
    .map(({ field }) => ({
      fieldPath: field.path,
      filePath: `content/rich-text/${field.path.replaceAll(".", "/")}.md`,
      markdown: serializeRichTextToMarkdown(
        parseSerializedRichTextDocument(field.value),
      ),
    }));
}

export function blogPostIdsForSiteDefinitionEdits(
  definition: SiteDefinition,
  edits: ReadonlyArray<SiteDefinitionEdit>,
): ReadonlyArray<BlogPostId> {
  const bindings = new Map(
    editableFieldBindings(definition).map((binding) => [
      binding.field.path,
      binding,
    ]),
  );
  return [
    ...new Set(
      edits.flatMap(({ path }) => {
        const postId = bindings.get(path)?.blogPostId;
        return postId === undefined ? [] : [postId];
      }),
    ),
  ];
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
    (edit.format ?? "plainText") !== binding.field.format ||
    (binding.field.values !== undefined &&
      !binding.field.values.includes(edit.value)) ||
    (edit.format !== "richText" &&
      (binding.validate?.(edit.value) ?? null) !== null)
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
  normalizeSeoShareImages(draft);
  return draft as unknown as SiteDefinition;
}

export function applySiteDefinitionEdits(
  definition: SiteDefinition,
  edits: ReadonlyArray<SiteDefinitionEdit>,
  isDefinition: (value: unknown) => value is SiteDefinition = isSiteDefinition,
): SiteDefinitionEditResult {
  const bindings = new Map(
    editableFieldBindings(definition).map((binding) => [
      binding.field.path,
      binding,
    ]),
  );
  const errors = Object.create(null) as Record<string, string>;
  for (const edit of edits) {
    const editedPostSlug = definition.blog.posts.some(
      ({ id }) => edit.path === `${id}.slug`,
    );
    if (!bindings.has(edit.path)) {
      errors[edit.path] =
        `This field is not in Site Definition ${definition.definitionVersion}.`;
    } else if (
      (edit.format ?? "plainText") !== bindings.get(edit.path)!.field.format
    ) {
      errors[edit.path] = "The field value format does not match its schema.";
    } else if (
      bindings.get(edit.path)!.field.format === "plainText" &&
      !bindings.get(edit.path)!.field.optional &&
      edit.value.trim() === ""
    ) {
      errors[edit.path] = "Enter at least one visible character.";
    } else if (
      editedPostSlug &&
      (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(edit.value) ||
        edit.value.length > 120)
    ) {
      errors[edit.path] =
        "Use at most 120 lowercase letters, numbers, and single hyphens.";
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
    if (errors[edit.path] === undefined) {
      const values = bindings.get(edit.path)!.field.values;
      if (values !== undefined && !values.includes(edit.value)) {
        errors[edit.path] =
          `Choose a value registered by Site Definition ${definition.definitionVersion}.`;
      }
    }
    if (errors[edit.path] === undefined && edit.format !== "richText") {
      const failure = bindings.get(edit.path)!.validate?.(edit.value) ?? null;
      if (failure !== null) {
        errors[edit.path] = failure;
      }
    }
  }
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  const draft = structuredClone(
    definition,
  ) as unknown as MutableSiteDefinition;
  const editedPostIds = new Set<string>();
  for (const edit of edits) {
    const binding = bindings.get(edit.path)!;
    binding.write(draft, edit.value);
    if (binding.blogPostId !== undefined) {
      editedPostIds.add(binding.blogPostId);
    }
  }
  normalizeSeoShareImages(draft);
  for (const postId of editedPostIds) {
    const post = draft.blog.posts.find(({ id }) => id === postId);
    if (post !== undefined) {
      post.revision += 1;
    }
  }
  const postsBySlug = new Map<string, string[]>();
  for (const post of draft.blog.posts) {
    const postIds = postsBySlug.get(post.slug) ?? [];
    postIds.push(post.id);
    postsBySlug.set(post.slug, postIds);
  }
  const duplicateSlugErrors = Object.create(null) as Record<string, string>;
  for (const postIds of postsBySlug.values()) {
    if (postIds.length < 2) {
      continue;
    }
    for (const postId of postIds) {
      duplicateSlugErrors[`${postId}.slug`] =
        "Choose a URL slug that is unique within this site.";
    }
  }
  if (Object.keys(duplicateSlugErrors).length > 0) {
    return { ok: false, errors: duplicateSlugErrors };
  }
  if (!isDefinition(draft)) {
    return {
      ok: false,
      errors: { blog: "The blog post does not match the current schema." },
    };
  }
  return {
    ok: true,
    definition: draft as unknown as SiteDefinition,
  };
}
