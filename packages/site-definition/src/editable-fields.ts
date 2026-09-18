import {
  parseSerializedRichTextDocument,
  richTextDocumentHasVisibleText,
  isSiteDefinition,
  serializeRichTextDocument,
  serializeRichTextToMarkdown,
  type BlogPostId,
  type PageSection,
  type SeoMetadata,
  type SerializedRichTextDocument,
  type SiteDefinition,
  type SiteHref,
} from "./index";
import {
  designContract,
  designTokenFieldPath,
  designTokenValue,
  sectionVariantFieldPath,
  setDesignTokenValue,
  type DesignTokenKey,
} from "./design-tokens";
import {
  normalizeCanonicalOrigin,
  seoFieldHints,
  seoKeywordLimit,
} from "./seo";
import { findPageById, homePageIndex, pageFieldPath } from "./pages";
import { parseSiteHref } from "./site-href";

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
  /**
   * A finer heading inside a group, so the editor can split one long group
   * into short cards the owner reads by area. The "Page" group uses this to
   * separate "Site settings" from each content section (Hero, Services, …).
   * Absent when the group is already short enough to show as one card.
   */
  section?: string;
  multiline: boolean;
  /**
   * The id of the page this field belongs to, absent when the field belongs
   * to the whole site or to a blog post. The editor reads it to show one
   * page's fields, and a caller reads it to tell two pages' fields apart.
   */
  pageId?: string;
  values?: ReadonlyArray<string>;
  /**
   * `true` when the owner may leave this field blank. A blank optional field
   * is not an error; it asks the renderer for its fallback.
   */
  optional: boolean;
  /** One short line telling the owner what happens when they leave it blank. */
  hint?: string;
  /**
   * Present only on a field that stores a `SiteHref`. Lists every page the
   * owner may point this link at, and the anchorable sections on each one, so
   * the editor can offer a page picker instead of a free-text box. Absent on
   * every other field.
   */
  siteHrefTargets?: ReadonlyArray<
    Readonly<{
      id: string;
      title: string;
      sections: ReadonlyArray<Readonly<{ id: string; label: string }>>;
    }>
  >;
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
  section?: string;
  multiline?: boolean;
  pageId?: string;
  values?: ReadonlyArray<string>;
  optional?: boolean;
  hint?: string;
  siteHrefTargets?: EditableSiteFieldBase["siteHrefTargets"];
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
  section,
  value,
  multiline = false,
  format = "plainText",
  pageId,
  values,
  optional = false,
  hint,
  siteHrefTargets,
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
      ...(section === undefined ? {} : { section }),
      value,
      multiline,
      format,
      optional,
      ...(pageId === undefined ? {} : { pageId }),
      ...(values === undefined ? {} : { values }),
      ...(hint === undefined ? {} : { hint }),
      ...(siteHrefTargets === undefined ? {} : { siteHrefTargets }),
    } as EditableSiteField,
    ...(blogPostId === undefined ? {} : { blogPostId }),
    ...(validate === undefined ? {} : { validate }),
    write,
  };
}

/**
 * One section of one page inside a mutable draft, ready to write to.
 *
 * A write reaches the section by position, because the draft is a copy of the
 * definition the field list was read from and holds the same pages in the same
 * order.
 */
function draftPageSection(
  draft: MutableSiteDefinition,
  pageIndex: number,
  sectionIndex: number,
): Record<string, any> {
  return draft.pages[pageIndex]!.sections[sectionIndex] as unknown as Record<
    string,
    any
  >;
}

/**
 * Drop any share image left without an address.
 *
 * The two share-image fields are written one at a time, so a draft can hold an
 * alt text that has no address yet. Run this once every edit in a batch has
 * been written: an image with no address is no image.
 */
function normalizeSeoShareImages(draft: MutableSiteDefinition): void {
  const seoBlocks = [
    ...draft.pages.map(({ seo }) => seo),
    ...draft.blog.posts.map(({ seo }) => seo),
  ];
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

/**
 * The card heading each content section's fields sit under in the editor. The
 * key is the section's type; the value is the plain name the owner reads.
 */
const contentSectionLabels: Record<string, string> = {
  hero: "Hero",
  services: "Services",
  proof: "Proof",
  callToAction: "Call to action",
};

/**
 * What the page picker calls one section, so an owner linking to "a section
 * on a page" reads a name instead of the section's internal id.
 */
function anchorSectionLabel(section: PageSection): string {
  const kind =
    section.type === "registered"
      ? section.component
      : contentSectionLabels[section.type] ?? section.type;
  const detail =
    "title" in section && section.title.trim() !== ""
      ? section.title.trim()
      : "eyebrow" in section && section.eyebrow.trim() !== ""
        ? section.eyebrow.trim()
        : "";
  return detail === "" ? kind : `${kind} — ${detail}`;
}

/**
 * The pages a link may point at, with their anchorable sections, for the
 * navigation page picker. Every page in field order, home page first, so the
 * picker lists pages the same way the Pages destination does.
 */
function siteHrefPageTargets(
  pages: ReadonlyArray<{ page: SiteDefinition["pages"][number] }>,
): EditableSiteFieldBase["siteHrefTargets"] {
  return pages.map(({ page }) => ({
    id: page.id,
    title: page.title,
    sections: page.sections.map((section) => ({
      id: section.id,
      label: anchorSectionLabel(section),
    })),
  }));
}

/**
 * The plain name the owner reads for one section, in the editor and in a
 * review summary. An installation-defined section has no owner-facing name of
 * its own, so it reads as "Section".
 */
export function pageSectionLabel(section: PageSection): string {
  return section.type === "registered"
    ? "Section"
    : contentSectionLabels[section.type] ?? section.type;
}

function editableFieldBindings(
  definition: SiteDefinition,
): EditableFieldBinding[] {
  /**
   * The one SEO and sharing field set, bound for whichever surface asks.
   * Every page and every blog post gets identical fields, so an owner
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
    pageId,
    select,
  }: {
    pathPrefix: string;
    labelPrefix: string;
    group: EditableSiteField["group"];
    seo: SeoMetadata;
    titleHint: string;
    descriptionHint: string;
    blogPostId?: BlogPostId;
    pageId?: string;
    select(draft: MutableSiteDefinition): DeepMutable<SeoMetadata>;
  }): EditableFieldBinding[] => {
    const shared = {
      group,
      ...(blogPostId === undefined ? {} : { blogPostId }),
      ...(pageId === undefined ? {} : { pageId }),
    };
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
  // One binding per registered design token. Driving these from the contract
  // means a new token is editable as soon as it is registered, and a removed
  // one disappears from the editor in the same change.
  const designTokenBindings = (
    Object.keys(designContract.tokens) as DesignTokenKey[]
  ).map((key) =>
    fieldBinding({
      path: designTokenFieldPath(key),
      label: designContract.tokens[key].label,
      group: "Design",
      value: designTokenValue(definition.design, key),
      multiline: false,
      values: designContract.tokens[key].values,
      write: (draft, value) => {
        setDesignTokenValue(draft.design, key, value);
      },
    }),
  );
  /**
   * Every page, with its position in `pages`, home page first.
   *
   * A write needs the position, because it writes into a mutable copy of the
   * same definition. The home page comes first so that a single-page site
   * yields exactly the field list, in exactly the order, it yielded before a
   * site could hold more than one page.
   */
  const homeIndex = homePageIndex(definition);
  const pagesInFieldOrder = [
    { page: definition.pages[homeIndex]!, pageIndex: homeIndex },
    ...definition.pages.flatMap((page, pageIndex) =>
      pageIndex === homeIndex ? [] : [{ page, pageIndex }],
    ),
  ];
  const fields: EditableFieldBinding[] = [
    ...designTokenBindings,
    fieldBinding({
      path: `${definition.site.id}.name`,
      label: "Site name",
      group: "Page",
      section: "Site settings",
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
      section: "Site settings",
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
    // A page's SEO paths already start with its page id, on the home page as
    // well as on every other page, so one rule covers them all.
    ...pagesInFieldOrder.flatMap(({ page, pageIndex }) =>
      seoFieldBindings({
        pathPrefix: page.id,
        labelPrefix: "Page",
        group: "SEO",
        pageId: page.id,
        seo: page.seo,
        titleHint: seoFieldHints.page.title,
        descriptionHint: seoFieldHints.page.description,
        select: (draft) => draft.pages[pageIndex]!.seo,
      }),
    ),
  ];

  const navigationHrefTargets = siteHrefPageTargets(pagesInFieldOrder);

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
      fieldBinding({
        path: `${item.id}.href`,
        label: `Navigation: ${item.label} — link`,
        group: "Navigation",
        value: item.href,
        multiline: false,
        siteHrefTargets: navigationHrefTargets,
        // Only a dangling page reference is rejected here, live. An email
        // address is not: the owner types it one character at a time, and
        // rejecting every incomplete address would revert the field on every
        // keystroke but the last. A malformed address still cannot be saved
        // as a finished edit — `isBaseSiteDefinition`'s schema check refuses
        // it before publish, the same gate every other field answers to.
        validate: (value) => {
          const parsed = parseSiteHref(value);
          return parsed.kind === "page" &&
            findPageById(definition, parsed.pageId) === undefined
            ? "Choose a page that still exists."
            : null;
        },
        write: (draft, value) => {
          draft.site.navigation[index]!.href = value as SiteHref;
        },
      }),
    );
  });

  /**
   * Every content section of every page, home page first, each one carrying
   * the page it belongs to and that page's position in `pages`.
   */
  const pageSections = pagesInFieldOrder.flatMap(({ page, pageIndex }) =>
    page.sections.map((section, sectionIndex) => ({
      page,
      pageIndex,
      section,
      sectionIndex,
    })),
  );

  pageSections.forEach(({ page, pageIndex, section, sectionIndex }) => {
    if (section.type === "registered") return;
    const variant = designContract.variants[section.type];
    // The card heading the editor shows for every field in this section, so
    // the owner reads "Hero" or "Services" instead of one long "Page" list.
    const sectionLabel = contentSectionLabels[section.type] ?? section.type;
    fields.push(
      fieldBinding({
        path: pageFieldPath(page, sectionVariantFieldPath(section.id)),
        label: variant.label,
        group: "Design",
        pageId: page.id,
        value: section.variant,
        multiline: false,
        values: variant.values,
        write: (draft, value) => {
          draftPageSection(draft, pageIndex, sectionIndex).variant = value;
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
          path: pageFieldPath(page, `${section.id}.${property}`),
          label,
          group: "Page",
          pageId: page.id,
          section: sectionLabel,
          value,
          multiline,
          write: (draft, nextValue) => {
            draftPageSection(draft, pageIndex, sectionIndex)[property] =
              nextValue;
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
          path: pageFieldPath(page, `${itemId}.label`),
          label,
          group: "Page",
          pageId: page.id,
          section: sectionLabel,
          value,
          multiline: false,
          write: (draft, nextValue) => {
            write(draftPageSection(draft, pageIndex, sectionIndex), nextValue);
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
                path: pageFieldPath(page, `${item.id}.${property}`),
                label,
                group: "Page",
                pageId: page.id,
                section: sectionLabel,
                value: item[property],
                multiline,
                write: (draft, nextValue) => {
                  const items = draftPageSection(
                    draft,
                    pageIndex,
                    sectionIndex,
                  ).items as Record<string, string>[];
                  items[itemIndex]![property] = nextValue;
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
                path: pageFieldPath(page, `${metric.id}.${property}`),
                label,
                group: "Page",
                pageId: page.id,
                section: sectionLabel,
                value: metric[property],
                multiline: false,
                write: (draft, nextValue) => {
                  const metrics = draftPageSection(
                    draft,
                    pageIndex,
                    sectionIndex,
                  ).metrics as Record<string, string>[];
                  metrics[metricIndex]![property] = nextValue;
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
            path: pageFieldPath(page, `${section.id}.body`),
            label: "Call to action body",
            group: "Page",
            pageId: page.id,
            section: sectionLabel,
            value: serializeRichTextDocument(section.body),
            multiline: true,
            format: "richText",
            write: (draft, value) => {
              draftPageSection(draft, pageIndex, sectionIndex).body =
                parseSerializedRichTextDocument(value);
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
    // "Summary" is the word the blog composer puts on this field, and the one
    // the SEO description hint names. One field, one word, on both surfaces.
    bindPostField("excerpt", "Post summary", true);
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
