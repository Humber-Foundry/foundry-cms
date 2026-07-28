export const projectedRichTextVersion = "1.0.0";

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

export function projectSiteDefinitionSchema(value) {
  if (
    !isRecord(value) ||
    !isRecord(value.home) ||
    !Array.isArray(value.home.sections)
  ) {
    throw new TypeError("site_definition_invalid");
  }
  if (
    value.definitionVersion === "1.1.0" &&
    value.schemaVersion === "1.1.0"
  ) {
    return value;
  }
  if (
    value.definitionVersion !== "1.0.0" ||
    value.schemaVersion !== "1.0.0"
  ) {
    throw new TypeError("site_definition_version_unsupported");
  }
  const projected = structuredClone(value);
  projected.definitionVersion = "1.1.0";
  projected.schemaVersion = "1.1.0";
  projected.home.sections = projected.home.sections.map((section) => {
    if (!isRecord(section) || section.type !== "callToAction") {
      return section;
    }
    if (typeof section.body !== "string") {
      throw new TypeError("site_definition_legacy_rich_text_invalid");
    }
    return {
      ...section,
      body: projectPlainTextRichTextDocument(section.body),
    };
  });
  return projected;
}

export function projectPublishedSiteDefinition(value) {
  const projected = projectSiteDefinitionSchema(value);
  return {
    ...projected,
    home: {
      ...projected.home,
      media: projected.home.media ?? [],
    },
  };
}
