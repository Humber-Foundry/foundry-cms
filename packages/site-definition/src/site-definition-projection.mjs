export const projectedRichTextVersion = "1.0.0";
export const projectedSiteDefinitionVersion = "1.4.0";

const projectedDefaultSiteDesign = Object.freeze({
  typography: Object.freeze({ heading: "editorial" }),
  colour: Object.freeze({ accent: "moss" }),
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
  if (isRecord(projected.home) && isRecord(projected.home.seo)) {
    seoBlocks.push(projected.home.seo);
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

export function projectSiteDefinitionSchema(value) {
  if (
    !isRecord(value) ||
    !isRecord(value.home) ||
    !Array.isArray(value.home.sections)
  ) {
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
    (value.schemaVersion !== "1.0.0" &&
      value.schemaVersion !== "1.1.0" &&
      value.schemaVersion !== "1.2.0" &&
      value.schemaVersion !== "1.3.0")
  ) {
    throw new TypeError("site_definition_version_unsupported");
  }
  const projected = structuredClone(value);
  const needsDesignProjection = projected.schemaVersion === "1.0.0";
  projected.definitionVersion = projectedSiteDefinitionVersion;
  projected.schemaVersion = projectedSiteDefinitionVersion;
  projected.blog ??= { id: "blog", posts: [] };
  projectSeoMetadata(projected);
  if (needsDesignProjection) {
    projected.design ??= projectedDefaultSiteDesign;
  }
  projected.home.sections = projected.home.sections.map((section) => {
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
  return projected;
}

export function projectPublishedSiteDefinition(value) {
  const projected = projectSiteDefinitionSchema(value);
  if (projected === value) {
    return projected;
  }
  return {
    ...projected,
    home: {
      ...projected.home,
      media: projected.home.media ?? [],
    },
  };
}
