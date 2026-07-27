export const RICH_TEXT_VERSION = "1.0.0" as const;

export type RichTextLinkMark = Readonly<{
  type: "link";
  href: string;
}>;

export type RichTextMark = "bold" | "italic" | RichTextLinkMark;

export type RichTextText = Readonly<{
  type: "text";
  text: string;
  marks: ReadonlyArray<RichTextMark>;
}>;

export type RichTextParagraph = Readonly<{
  type: "paragraph";
  children: ReadonlyArray<RichTextText>;
}>;

export type RichTextHeading = Readonly<{
  type: "heading";
  level: 1 | 2 | 3 | 4 | 5 | 6;
  children: ReadonlyArray<RichTextText>;
}>;

export type RichTextBlockquote = Readonly<{
  type: "blockquote";
  children: ReadonlyArray<RichTextParagraph>;
}>;

export type RichTextListItem = Readonly<{
  type: "listItem";
  children: ReadonlyArray<RichTextParagraph>;
}>;

export type RichTextList = Readonly<{
  type: "bulletList" | "orderedList";
  children: ReadonlyArray<RichTextListItem>;
}>;

export type RichTextBlock =
  | RichTextParagraph
  | RichTextHeading
  | RichTextBlockquote
  | RichTextList;

export type RichTextDocument = Readonly<{
  version: typeof RICH_TEXT_VERSION;
  type: "document";
  children: ReadonlyArray<RichTextBlock>;
}>;

export type RichTextValidationIssue = Readonly<{
  code:
    | "ambiguous_text"
    | "serializer_ambiguity"
    | "duplicate_mark"
    | "invalid_node"
    | "invalid_structure"
    | "unsafe_link"
    | "unsupported_attribute"
    | "unsupported_mark"
    | "unsupported_node"
    | "unsupported_version";
  path: string;
  message: string;
}>;

export class RichTextValidationError extends Error {
  readonly issues: ReadonlyArray<RichTextValidationIssue>;

  constructor(issues: ReadonlyArray<RichTextValidationIssue>) {
    super("rich_text_validation_failed");
    this.name = "RichTextValidationError";
    this.issues = issues;
  }
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(
  code: RichTextValidationIssue["code"],
  path: string,
  message: string,
): never {
  throw new RichTextValidationError([{ code, path, message }]);
}

function assertOnlyKeys(
  value: JsonObject,
  keys: ReadonlyArray<string>,
  path: string,
) {
  const allowed = new Set(keys);
  const key = Object.keys(value).find((candidate) => !allowed.has(candidate));
  if (key !== undefined) {
    issue(
      "unsupported_attribute",
      `${path}.${key}`,
      `The attribute "${key}" is not part of Rich Text ${RICH_TEXT_VERSION}.`,
    );
  }
}

function isSafeLink(href: string): boolean {
  if (
    href.length === 0 ||
    href.length > 2_048 ||
    /[\u0000-\u0020\u007f]/u.test(href)
  ) {
    return false;
  }
  if (href.startsWith("#")) {
    return /^#[A-Za-z][A-Za-z0-9_-]*$/u.test(href);
  }
  if (href.startsWith("/")) {
    return !href.startsWith("//");
  }
  try {
    const parsed = new URL(href);
    return (
      parsed.protocol === "https:" ||
      parsed.protocol === "http:" ||
      (parsed.protocol === "mailto:" &&
        /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(parsed.pathname))
    );
  } catch {
    return false;
  }
}

export function isSafeRichTextLink(href: string): boolean {
  return isSafeLink(href);
}

function validateText(text: RichTextText, path: string) {
  if (!isObject(text) || text.type !== "text" || typeof text.text !== "string") {
    issue("invalid_node", path, "Expected a text node.");
  }
  assertOnlyKeys(text, ["type", "text", "marks"], path);
  if (/[\r\n]/u.test(text.text)) {
    issue(
      "ambiguous_text",
      `${path}.text`,
      "Text nodes cannot contain line breaks; use block nodes instead.",
    );
  }
  if (text.text.length === 0) {
    issue(
      "serializer_ambiguity",
      `${path}.text`,
      "Empty text nodes have no distinct Markdown representation.",
    );
  }
  if (!Array.isArray(text.marks)) {
    issue("invalid_node", `${path}.marks`, "Expected a marks array.");
  }
  const seen = new Set<string>();
  text.marks.forEach((mark, index) => {
    const markPath = `${path}.marks[${index}]`;
    const kind =
      typeof mark === "string"
        ? mark
        : isObject(mark) && mark.type === "link"
          ? "link"
          : "unsupported";
    if (kind === "unsupported" || !["bold", "italic", "link"].includes(kind)) {
      issue("unsupported_mark", markPath, "This rich-text mark is not supported.");
    }
    if (seen.has(kind)) {
      issue("duplicate_mark", markPath, `The ${kind} mark appears more than once.`);
    }
    seen.add(kind);
    if (kind === "link") {
      const link = mark as RichTextLinkMark;
      assertOnlyKeys(link, ["type", "href"], markPath);
      if (typeof link.href !== "string" || !isSafeLink(link.href)) {
        issue(
          "unsafe_link",
          `${markPath}.href`,
          "Links must use http, https, mailto, a root-relative path, or a page anchor.",
        );
      }
    }
  });
  const markOrder = text.marks.map((mark) =>
    typeof mark === "string" ? mark : mark.type,
  );
  const canonicalOrder = ["bold", "italic", "link"].filter((mark) =>
    markOrder.includes(mark),
  );
  if (markOrder.some((mark, index) => mark !== canonicalOrder[index])) {
    issue(
      "serializer_ambiguity",
      `${path}.marks`,
      "Marks must use canonical bold, italic, link order.",
    );
  }
}

function validateParagraph(value: RichTextParagraph, path: string) {
  if (!isObject(value) || value.type !== "paragraph") {
    issue("invalid_node", path, "Expected a paragraph node.");
  }
  assertOnlyKeys(value, ["type", "children"], path);
  if (!Array.isArray(value.children)) {
    issue("invalid_structure", `${path}.children`, "Expected paragraph children.");
  }
  value.children.forEach((child, index) =>
    validateText(child, `${path}.children[${index}]`),
  );
  value.children.forEach((child, index) => {
    const previous = value.children[index - 1];
    if (
      previous !== undefined &&
      JSON.stringify(previous.marks) === JSON.stringify(child.marks)
    ) {
      issue(
        "serializer_ambiguity",
        `${path}.children[${index}]`,
        "Adjacent text nodes with identical marks must be combined.",
      );
    }
  });
}

export function validateRichTextDocument(
  value: RichTextDocument,
): RichTextDocument {
  if (!isObject(value)) {
    issue("invalid_node", "$", "Expected a rich-text document.");
  }
  assertOnlyKeys(value, ["version", "type", "children"], "$");
  if (value.version !== RICH_TEXT_VERSION) {
    issue(
      "unsupported_version",
      "$.version",
      `Only Rich Text ${RICH_TEXT_VERSION} is supported.`,
    );
  }
  if (value.type !== "document" || !Array.isArray(value.children)) {
    issue("invalid_structure", "$", "Expected a document with block children.");
  }
  value.children.forEach((block, blockIndex) => {
    const path = `$.children[${blockIndex}]`;
    if (!isObject(block) || typeof block.type !== "string") {
      issue("invalid_node", path, "Expected a rich-text block.");
    }
    switch (block.type) {
      case "paragraph":
        validateParagraph(block as unknown as RichTextParagraph, path);
        break;
      case "heading":
        assertOnlyKeys(block, ["type", "level", "children"], path);
        if (
          !Number.isInteger(block.level) ||
          Number(block.level) < 1 ||
          Number(block.level) > 6
        ) {
          issue(
            "invalid_structure",
            `${path}.level`,
            "Heading level must be an integer from 1 through 6.",
          );
        }
        if (!Array.isArray(block.children)) {
          issue("invalid_structure", `${path}.children`, "Expected heading children.");
        }
        block.children.forEach((child, index) =>
          validateText(child, `${path}.children[${index}]`),
        );
        break;
      case "blockquote":
        assertOnlyKeys(block, ["type", "children"], path);
        if (!Array.isArray(block.children) || block.children.length === 0) {
          issue(
            "invalid_structure",
            `${path}.children`,
            "Blockquotes require at least one paragraph.",
          );
        }
        block.children.forEach((child, index) =>
          validateParagraph(child, `${path}.children[${index}]`),
        );
        break;
      case "bulletList":
      case "orderedList":
        assertOnlyKeys(block, ["type", "children"], path);
        if (!Array.isArray(block.children) || block.children.length === 0) {
          issue(
            "invalid_structure",
            `${path}.children`,
            "Lists require at least one list item.",
          );
        }
        block.children.forEach((item, itemIndex) => {
          const itemPath = `${path}.children[${itemIndex}]`;
          if (!isObject(item) || item.type !== "listItem") {
            issue("invalid_structure", itemPath, "Expected a list item.");
          }
          assertOnlyKeys(item, ["type", "children"], itemPath);
          if (!Array.isArray(item.children) || item.children.length === 0) {
            issue(
              "invalid_structure",
              `${itemPath}.children`,
              "List items require at least one paragraph.",
            );
          }
          item.children.forEach((child, index) =>
            validateParagraph(child, `${itemPath}.children[${index}]`),
          );
        });
        break;
      default:
        issue(
          "unsupported_node",
          `${path}.type`,
          `The "${block.type}" block is not supported.`,
        );
    }
  });
  return value;
}

function tipTapMarksToRichText(value: unknown, path: string): RichTextMark[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    issue("invalid_node", path, "Expected a TipTap marks array.");
  }
  const marks = value.map((mark, index): RichTextMark => {
    const markPath = `${path}[${index}]`;
    if (!isObject(mark) || typeof mark.type !== "string") {
      issue("invalid_node", markPath, "Expected a TipTap mark.");
    }
    if (mark.type === "bold" || mark.type === "italic") {
      assertOnlyKeys(mark, ["type"], markPath);
      return mark.type;
    }
    if (mark.type === "link") {
      assertOnlyKeys(mark, ["type", "attrs"], markPath);
      if (!isObject(mark.attrs) || typeof mark.attrs.href !== "string") {
        issue("invalid_node", `${markPath}.attrs.href`, "Expected a link href.");
      }
      const allowedLinkAttributes = ["href", "target", "rel", "class"];
      assertOnlyKeys(mark.attrs, allowedLinkAttributes, `${markPath}.attrs`);
      return { type: "link", href: mark.attrs.href };
    }
    issue(
      "unsupported_mark",
      `${markPath}.type`,
      `The TipTap "${mark.type}" mark is not supported.`,
    );
  });
  const order = new Map([
    ["bold", 0],
    ["italic", 1],
    ["link", 2],
  ]);
  return marks.sort(
    (left, right) =>
      order.get(typeof left === "string" ? left : left.type)! -
      order.get(typeof right === "string" ? right : right.type)!,
  );
}

function fromTipTapText(value: unknown, path: string): RichTextText {
  if (!isObject(value) || value.type !== "text" || typeof value.text !== "string") {
    issue("invalid_node", path, "Expected a TipTap text node.");
  }
  assertOnlyKeys(value, ["type", "text", "marks"], path);
  return {
    type: "text",
    text: value.text,
    marks: tipTapMarksToRichText(value.marks, `${path}.marks`),
  };
}

function fromTipTapParagraph(value: unknown, path: string): RichTextParagraph {
  if (!isObject(value) || value.type !== "paragraph") {
    issue("invalid_node", path, "Expected a TipTap paragraph.");
  }
  assertOnlyKeys(value, ["type", "content"], path);
  const content = value.content ?? [];
  if (!Array.isArray(content)) {
    issue("invalid_structure", `${path}.content`, "Expected TipTap content.");
  }
  return {
    type: "paragraph",
    children: combineAdjacentText(
      content.map((child, index) =>
        fromTipTapText(child, `${path}.content[${index}]`),
      ),
    ),
  };
}

function combineAdjacentText(
  children: ReadonlyArray<RichTextText>,
): RichTextText[] {
  const combined: RichTextText[] = [];
  for (const child of children) {
    if (child.text.length === 0) {
      continue;
    }
    const previous = combined.at(-1);
    if (
      previous !== undefined &&
      JSON.stringify(previous.marks) === JSON.stringify(child.marks)
    ) {
      combined[combined.length - 1] = {
        ...previous,
        text: previous.text + child.text,
      };
    } else {
      combined.push(child);
    }
  }
  return combined;
}

export function fromTipTapDocument(value: unknown): RichTextDocument {
  if (!isObject(value) || value.type !== "doc") {
    issue("invalid_node", "$", "Expected a TipTap doc node.");
  }
  assertOnlyKeys(value, ["type", "content"], "$");
  const content = value.content ?? [];
  if (!Array.isArray(content)) {
    issue("invalid_structure", "$.content", "Expected TipTap block content.");
  }
  const children = content.map((block, index): RichTextBlock => {
    const path = `$.content[${index}]`;
    if (!isObject(block) || typeof block.type !== "string") {
      issue("invalid_node", path, "Expected a TipTap block.");
    }
    switch (block.type) {
      case "paragraph":
        return fromTipTapParagraph(block, path);
      case "heading": {
        assertOnlyKeys(block, ["type", "attrs", "content"], path);
        if (
          !isObject(block.attrs) ||
          !Number.isInteger(block.attrs.level) ||
          Number(block.attrs.level) < 1 ||
          Number(block.attrs.level) > 6
        ) {
          issue(
            "invalid_structure",
            `${path}.attrs.level`,
            "TipTap heading level must be an integer from 1 through 6.",
          );
        }
        assertOnlyKeys(block.attrs, ["level"], `${path}.attrs`);
        const headingContent = block.content ?? [];
        if (!Array.isArray(headingContent)) {
          issue("invalid_structure", `${path}.content`, "Expected heading content.");
        }
        return {
          type: "heading",
          level: block.attrs.level as RichTextHeading["level"],
          children: combineAdjacentText(
            headingContent.map((child, childIndex) =>
              fromTipTapText(child, `${path}.content[${childIndex}]`),
            ),
          ),
        };
      }
      case "blockquote": {
        assertOnlyKeys(block, ["type", "content"], path);
        if (!Array.isArray(block.content)) {
          issue("invalid_structure", `${path}.content`, "Expected quote content.");
        }
        return {
          type: "blockquote",
          children: block.content.map((child, childIndex) =>
            fromTipTapParagraph(child, `${path}.content[${childIndex}]`),
          ),
        };
      }
      case "bulletList":
      case "orderedList": {
        assertOnlyKeys(
          block,
          block.type === "orderedList"
            ? ["type", "attrs", "content"]
            : ["type", "content"],
          path,
        );
        if (block.type === "orderedList" && block.attrs !== undefined) {
          if (!isObject(block.attrs)) {
            issue("invalid_structure", `${path}.attrs`, "Expected list attributes.");
          }
          assertOnlyKeys(block.attrs, ["start"], `${path}.attrs`);
          if (block.attrs.start !== 1) {
            issue(
              "unsupported_attribute",
              `${path}.attrs.start`,
              "Only ordered lists beginning at 1 have a canonical representation.",
            );
          }
        }
        if (!Array.isArray(block.content)) {
          issue("invalid_structure", `${path}.content`, "Expected list content.");
        }
        return {
          type: block.type,
          children: block.content.map((item, itemIndex) => {
            const itemPath = `${path}.content[${itemIndex}]`;
            if (!isObject(item) || item.type !== "listItem") {
              issue("invalid_structure", itemPath, "Expected a TipTap list item.");
            }
            assertOnlyKeys(item, ["type", "content"], itemPath);
            if (!Array.isArray(item.content)) {
              issue(
                "invalid_structure",
                `${itemPath}.content`,
                "Expected list-item content.",
              );
            }
            return {
              type: "listItem",
              children: item.content.map((child, childIndex) =>
                fromTipTapParagraph(
                  child,
                  `${itemPath}.content[${childIndex}]`,
                ),
              ),
            };
          }),
        };
      }
      default:
        issue(
          "unsupported_node",
          `${path}.type`,
          `The TipTap "${block.type}" node is not supported.`,
        );
    }
  });
  return validateRichTextDocument({
    version: RICH_TEXT_VERSION,
    type: "document",
    children,
  });
}

function toTipTapText(node: RichTextText): JsonObject {
  return {
    type: "text",
    text: node.text,
    ...(node.marks.length === 0
      ? {}
      : {
          marks: node.marks.map((mark) =>
            typeof mark === "string"
              ? { type: mark }
              : { type: "link", attrs: { href: mark.href } },
          ),
        }),
  };
}

function toTipTapParagraph(node: RichTextParagraph): JsonObject {
  return {
    type: "paragraph",
    ...(node.children.length === 0
      ? {}
      : { content: node.children.map(toTipTapText) }),
  };
}

export function toTipTapDocument(document: RichTextDocument): JsonObject {
  validateRichTextDocument(document);
  return {
    type: "doc",
    ...(document.children.length === 0
      ? {}
      : {
          content: document.children.map((block): JsonObject => {
            switch (block.type) {
              case "paragraph":
                return toTipTapParagraph(block);
              case "heading":
                return {
                  type: "heading",
                  attrs: { level: block.level },
                  ...(block.children.length === 0
                    ? {}
                    : { content: block.children.map(toTipTapText) }),
                };
              case "blockquote":
                return {
                  type: "blockquote",
                  content: block.children.map(toTipTapParagraph),
                };
              case "bulletList":
              case "orderedList":
                return {
                  type: block.type,
                  ...(block.type === "orderedList" ? { attrs: { start: 1 } } : {}),
                  content: block.children.map((item) => ({
                    type: "listItem",
                    content: item.children.map(toTipTapParagraph),
                  })),
                };
            }
          }),
        }),
  };
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\`*{}[\]()<>#+\-!_|>])/gu, "\\$1");
}

function escapeMarkdownDestination(value: string): string {
  return value.replace(/([\\()])/gu, "\\$1");
}

function serializeText(node: RichTextText): string {
  let value = escapeMarkdownText(node.text);
  const bold = node.marks.includes("bold");
  const italic = node.marks.includes("italic");
  if (bold && italic) {
    value = `***${value}***`;
  } else if (bold) {
    value = `**${value}**`;
  } else if (italic) {
    value = `*${value}*`;
  }
  const link = node.marks.find(
    (mark): mark is RichTextLinkMark =>
      typeof mark === "object" && mark.type === "link",
  );
  return link === undefined
    ? value
    : `[${value}](${escapeMarkdownDestination(link.href)})`;
}

function serializeParagraph(paragraph: RichTextParagraph): string {
  return paragraph.children.map(serializeText).join("");
}

export function serializeRichTextToMarkdown(
  document: RichTextDocument,
): string {
  validateRichTextDocument(document);
  const blocks = document.children.map((block) => {
    switch (block.type) {
      case "paragraph":
        return serializeParagraph(block);
      case "heading":
        return `${"#".repeat(block.level)} ${block.children
          .map(serializeText)
          .join("")}`;
      case "blockquote":
        return block.children
          .map((paragraph) => `> ${serializeParagraph(paragraph)}`)
          .join("\n>\n");
      case "bulletList":
      case "orderedList":
        return block.children
          .map((item, index) => {
            const marker = block.type === "bulletList" ? "-" : `${index + 1}.`;
            return item.children
              .map(
                (paragraph, paragraphIndex) =>
                  `${paragraphIndex === 0 ? `${marker} ` : "  "}${serializeParagraph(
                    paragraph,
                  )}`,
              )
              .join("\n");
          })
          .join("\n");
    }
  });
  return blocks.length === 0 ? "" : `${blocks.join("\n\n")}\n`;
}
