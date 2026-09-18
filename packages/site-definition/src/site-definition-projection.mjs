export const projectedRichTextVersion = "1.0.0";
export const projectedSiteDefinitionVersion = "1.7.0";

const projectedSupportedStoredVersions = Object.freeze([
  "1.0.0",
  "1.1.0",
  "1.2.0",
  "1.3.0",
  "1.4.0",
  "1.5.0",
  "1.6.0",
]);

/** The slug of the home page. The same value as `homePageSlug` in pages.ts. */
const projectedHomePageSlug = "";

const projectedDefaultSiteDesign = Object.freeze({
  typography: Object.freeze({ heading: "editorial", body: "modern" }),
  colour: Object.freeze({ accent: "moss", neutral: "warm" }),
  spacing: Object.freeze({ section: "relaxed" }),
  layout: Object.freeze({ contentWidth: "standard" }),
});

const projectedDefaultComponentVariants = Object.freeze({
  hero: "editorial",
  services: "list",
  proof: "panel",
  callToAction: "moss",
});

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The pages of a definition, whichever shape it is stored in.
 *
 * A definition stored before 1.7.0 has one `home` object. A definition stored
 * at 1.7.0 or later has a `pages` array. The steps that fill older fields run
 * before the page-collection step, so they must read both shapes.
 */
function projectedPages(projected) {
  if (isRecord(projected.home)) {
    return [projected.home];
  }
  return Array.isArray(projected.pages) ? projected.pages.filter(isRecord) : [];
}

export function projectPlainTextRichTextDocument(value) {
  return {
    version: projectedRichTextVersion,
    type: "document",
    children: value.split(/\r\n?|\n/u).map((text) => ({
      type: "paragraph",
      children:
        text === ""
          ? []
          : [{ type: "text", text, marks: [] }],
    })),
  };
}

/**
 * Fill the 1.4.0 sharing fields on a definition stored under an older schema.
 *
 * A definition written before 1.4.0 has no canonical origin, no keywords and
 * no share image. Each one projects to the value that means "not set", so an
 * upgraded definition renders exactly what it rendered before until an owner
 * fills the new fields.
 */
function projectSeoMetadata(projected) {
  if (isRecord(projected.site)) {
    projected.site.canonicalOrigin ??= "";
  }
  const seoBlocks = [];
  for (const page of projectedPages(projected)) {
    if (isRecord(page.seo)) {
      seoBlocks.push(page.seo);
    }
  }
  if (isRecord(projected.blog) && Array.isArray(projected.blog.posts)) {
    for (const post of projected.blog.posts) {
      if (isRecord(post) && isRecord(post.seo)) {
        seoBlocks.push(post.seo);
      }
    }
  }
  for (const seo of seoBlocks) {
    seo.keywords ??= [];
    seo.shareImage ??= null;
  }
}

/**
 * Fill the 1.6.0 blog main image on posts stored under an older schema.
 *
 * A post written before 1.6.0 has no header image. It projects to `null`,
 * which means "no main image", so an upgraded post renders exactly as before
 * until an owner sets one. See ADR-0013.
 */
function projectBlogMainImage(projected) {
  if (!isRecord(projected.blog) || !Array.isArray(projected.blog.posts)) {
    return;
  }
  for (const post of projected.blog.posts) {
    if (isRecord(post)) {
      post.mainImage ??= null;
    }
  }
}

/**
 * Turn the 1.6.0 `home` object into the 1.7.0 `pages` collection.
 *
 * The one page keeps the id, the media, the SEO block and the sections it
 * already had, byte for byte. It gains the root slug, so it is still served at
 * `/`, and a title, which the Pages list needs. The title is the site name,
 * because that is what a blank home SEO title already falls back to, so the
 * upgraded site renders exactly what it rendered before.
 *
 * See ADR-0016.
 */
function projectPageCollection(projected) {
  if (!isRecord(projected.home)) {
    return;
  }
  const { home } = projected;
  const siteName = isRecord(projected.site) && typeof projected.site.name === "string"
    ? projected.site.name
    : "Home";
  const page = {
    id: home.id,
    slug: projectedHomePageSlug,
    title: siteName,
    ...(home.media === undefined ? {} : { media: home.media }),
    seo: home.seo,
    sections: home.sections,
  };
  delete projected.home;
  projected.pages = [page];
}

export function projectSiteDefinitionSchema(value) {
  const storedAsOnePage =
    isRecord(value) && isRecord(value.home) && Array.isArray(value.home.sections);
  const storedAsPageCollection =
    isRecord(value) && !isRecord(value.home) && Array.isArray(value.pages);
  if (!storedAsOnePage && !storedAsPageCollection) {
    throw new TypeError("site_definition_invalid");
  }
  if (
    value.definitionVersion === projectedSiteDefinitionVersion &&
    value.schemaVersion === projectedSiteDefinitionVersion
  ) {
    return value;
  }
  if (
    value.definitionVersion !== value.schemaVersion ||
    !projectedSupportedStoredVersions.includes(value.schemaVersion)
  ) {
    throw new TypeError("site_definition_version_unsupported");
  }
  const projected = structuredClone(value);
  const needsDesignProjection = projected.schemaVersion === "1.0.0";
  projected.definitionVersion = projectedSiteDefinitionVersion;
  projected.schemaVersion = projectedSiteDefinitionVersion;
  projected.blog ??= { id: "blog", posts: [] };
  // The sharing fields arrived with 1.4.0. Fill them first, so a definition
  // stored before 1.4.0 gains the "not set" values it would have had.
  projectSeoMetadata(projected);
  // The blog main image arrived with 1.6.0. A post stored before it gains the
  // "no main image" value it would have had.
  projectBlogMainImage(projected);
  if (needsDesignProjection) {
    // A clone, never the frozen constant itself: the design step below writes
    // into this object, and writing into a frozen one throws.
    projected.design ??= structuredClone(projectedDefaultSiteDesign);
  }
  // Body font and page tone arrived with 1.5.0, after the sharing fields, so
  // this step runs after the sharing step. Every definition stored before
  // 1.5.0 kept the sans body text and the warm paper the stylesheet used
  // before them, so the projected site looks exactly as it did.
  if (isRecord(projected.design)) {
    if (isRecord(projected.design.typography)) {
      projected.design.typography.body ??=
        projectedDefaultSiteDesign.typography.body;
    }
    if (isRecord(projected.design.colour)) {
      projected.design.colour.neutral ??=
        projectedDefaultSiteDesign.colour.neutral;
    }
  }
  for (const page of projectedPages(projected)) {
    if (!Array.isArray(page.sections)) {
      throw new TypeError("site_definition_invalid");
    }
    page.sections = page.sections.map((section) => {
      if (!isRecord(section) || typeof section.type !== "string") {
        return section;
      }
      if (
        needsDesignProjection &&
        section.type in projectedDefaultComponentVariants
      ) {
        section.variant ??=
          projectedDefaultComponentVariants[section.type];
      }
      if (section.type !== "callToAction") {
        return section;
      }
      if (typeof section.body === "string") {
        return {
          ...section,
          body: projectPlainTextRichTextDocument(section.body),
        };
      }
      if (!isRecord(section.body)) {
        throw new TypeError("site_definition_legacy_rich_text_invalid");
      }
      return section;
    });
  }
  // The page collection arrived with 1.7.0, after every field step above, so
  // it runs last. Each step above reads whichever shape the definition is
  // stored in through `projectedPages`.
  projectPageCollection(projected);
  return projected;
}

export function projectPublishedSiteDefinition(value) {
  const projected = projectSiteDefinitionSchema(value);
  if (projected === value) {
    return projected;
  }
  return {
    ...projected,
    pages: projected.pages.map((page) => ({
      ...page,
      media: page.media ?? [],
    })),
  };
}
