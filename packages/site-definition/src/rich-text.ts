import {
  projectPlainTextRichTextDocument,
  projectedRichTextVersion,
} from "./site-definition-projection.mjs";

export const RICH_TEXT_VERSION = projectedRichTextVersion;
export const SAFE_RICH_TEXT_LINK_PATTERN =
  "^(?:https?://[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::[0-9]{1,4})?(?:[/?#][^\\u0000-\\u0020\\u007f\\\\]*)?|mailto:[^\\u0000-\\u0020\\u007f\\\\@]+@[^\\u0000-\\u0020\\u007f\\\\@]+\\.[^\\u0000-\\u0020\\u007f\\\\@]+|/(?!/)[^\\u0000-\\u0020\\u007f\\\\]*|#[A-Za-z][A-Za-z0-9_-]*)$";
declare const serializedRichTextDocumentBrand: unique symbol;

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
  level: 2 | 3 | 4 | 5;
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

export type RichTextList =
  | Readonly<{
      type: "bulletList";
      children: ReadonlyArray<RichTextListItem>;
    }>
  | Readonly<{
      type: "orderedList";
      children: ReadonlyArray<RichTextListItem>;
    }>;

export type RichTextBlock =
  | RichTextParagraph
  | RichTextHeading
  | RichTextBlockquote
  | RichTextList;

export type RichTextBlockVisitor<Result> = Readonly<{
  paragraph(block: RichTextParagraph): Result;
  heading(block: RichTextHeading): Result;
  blockquote(block: RichTextBlockquote): Result;
  bulletList(block: Extract<RichTextList, { type: "bulletList" }>): Result;
  orderedList(block: Extract<RichTextList, { type: "orderedList" }>): Result;
}>;

export function visitRichTextBlock<Result>(
  block: RichTextBlock,
  visitor: RichTextBlockVisitor<Result>,
): Result {
  switch (block.type) {
    case "paragraph":
      return visitor.paragraph(block);
    case "heading":
      return visitor.heading(block);
    case "blockquote":
      return visitor.blockquote(block);
    case "bulletList":
      return visitor.bulletList(block);
    case "orderedList":
      return visitor.orderedList(block);
  }
}

export type RichTextDocument = Readonly<{
  version: typeof RICH_TEXT_VERSION;
  type: "document";
  children: ReadonlyArray<RichTextBlock>;
}>;

export function createRichTextDocumentFromPlainText(
  value: string,
): RichTextDocument {
  return projectPlainTextRichTextDocument(value) as RichTextDocument;
}

export type SerializedRichTextDocument = string & {
  readonly [serializedRichTextDocumentBrand]: "SerializedRichTextDocument";
};

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

const safeRichTextLinkPattern = new RegExp(
  SAFE_RICH_TEXT_LINK_PATTERN,
  "u",
);

function isSafeLink(href: string): boolean {
  if (
    href.length === 0 ||
    href.length > 2_048 ||
    /[\u0000-\u0020\u007f]/u.test(href) ||
    href.includes("\\")
  ) {
    return false;
  }
  return safeRichTextLinkPattern.test(href);
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
  if (
    text.marks.some((mark) => mark === "bold" || mark === "italic") &&
    (/^\s/u.test(text.text) || /\s$/u.test(text.text))
  ) {
    issue(
      "serializer_ambiguity",
      `${path}.text`,
      "Bold and italic text cannot begin or end with whitespace in canonical CommonMark.",
    );
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
  validateInlineChildren(value.children, `${path}.children`);
}

function firstCodePoint(value: string): string | undefined {
  return Array.from(value)[0];
}

function lastCodePoint(value: string): string | undefined {
  return Array.from(value).at(-1);
}

function isCommonMarkWhitespace(value: string | undefined): boolean {
  return (
    value === undefined ||
    /[\t\n\f\r]/u.test(value) ||
    /\p{Zs}/u.test(value)
  );
}

function isCommonMarkPunctuation(value: string | undefined): boolean {
  return value !== undefined && /[\p{P}\p{S}]/u.test(value);
}

function isLeftFlankingDelimiter(
  before: string | undefined,
  after: string | undefined,
): boolean {
  return (
    !isCommonMarkWhitespace(after) &&
    (!isCommonMarkPunctuation(after) ||
      isCommonMarkWhitespace(before) ||
      isCommonMarkPunctuation(before))
  );
}

function isRightFlankingDelimiter(
  before: string | undefined,
  after: string | undefined,
): boolean {
  return (
    !isCommonMarkWhitespace(before) &&
    (!isCommonMarkPunctuation(before) ||
      isCommonMarkWhitespace(after) ||
      isCommonMarkPunctuation(after))
  );
}

function hasEmphasisMark(node: RichTextText): boolean {
  return node.marks.some((mark) => mark === "bold" || mark === "italic");
}

function hasLinkMark(node: RichTextText): boolean {
  return node.marks.some(
    (mark) => typeof mark === "object" && mark.type === "link",
  );
}

function firstEscapedTextCodePoint(node: RichTextText): string | undefined {
  return firstCodePoint(escapeMarkdownText(node.text));
}

function lastEscapedTextCodePoint(node: RichTextText): string | undefined {
  return lastCodePoint(escapeMarkdownText(node.text));
}

function validateCommonMarkEmphasisBoundaries(
  children: ReadonlyArray<RichTextText>,
  path: string,
) {
  let joinedEmphasisNodes = 0;
  children.forEach((child, index) => {
    if (!hasEmphasisMark(child)) {
      joinedEmphasisNodes = 0;
      return;
    }
    const linked = hasLinkMark(child);
    joinedEmphasisNodes = linked ? 0 : joinedEmphasisNodes + 1;
    if (joinedEmphasisNodes > 2) {
      issue(
        "serializer_ambiguity",
        `${path}[${index}].marks`,
        "Three or more adjacent unlinked emphasis nodes create ambiguous CommonMark delimiter runs.",
      );
    }
    const previous = children[index - 1];
    const next = children[index + 1];
    const beforeOpening = linked
      ? "["
      : previous === undefined
        ? undefined
        : hasEmphasisMark(previous) && !hasLinkMark(previous)
          ? lastEscapedTextCodePoint(previous)
          : lastCodePoint(serializeText(previous));
    const afterClosing = linked
      ? "]"
      : next === undefined
        ? undefined
        : hasEmphasisMark(next) && !hasLinkMark(next)
          ? firstEscapedTextCodePoint(next)
          : firstCodePoint(serializeText(next));
    if (
      !isLeftFlankingDelimiter(
        beforeOpening,
        firstEscapedTextCodePoint(child),
      )
    ) {
      issue(
        "serializer_ambiguity",
        `${path}[${index}].text`,
        "Surrounding inline content prevents this emphasis mark from opening in canonical CommonMark.",
      );
    }
    if (
      !isRightFlankingDelimiter(
        lastEscapedTextCodePoint(child),
        afterClosing,
      )
    ) {
      issue(
        "serializer_ambiguity",
        `${path}[${index}].text`,
        "Surrounding inline content prevents this emphasis mark from closing in canonical CommonMark.",
      );
    }
  });
}

function validateInlineChildren(
  children: ReadonlyArray<RichTextText>,
  path: string,
) {
  children.forEach((child, index) =>
    validateText(child, `${path}[${index}]`),
  );
  children.forEach((child, index) => {
    const previous = children[index - 1];
    if (
      previous !== undefined &&
      JSON.stringify(previous.marks) === JSON.stringify(child.marks)
    ) {
      issue(
        "serializer_ambiguity",
        `${path}[${index}]`,
        "Adjacent text nodes with identical marks must be combined.",
      );
    }
  });
  validateCommonMarkEmphasisBoundaries(children, path);
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
          Number(block.level) < 2 ||
          Number(block.level) > 5
        ) {
          issue(
            "invalid_structure",
            `${path}.level`,
            "Heading level must be an integer from 2 through 5.",
          );
        }
        if (!Array.isArray(block.children)) {
          issue("invalid_structure", `${path}.children`, "Expected heading children.");
        }
        validateInlineChildren(block.children, `${path}.children`);
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
          if (item.children.length !== 1) {
            issue(
              "serializer_ambiguity",
              `${itemPath}.children`,
              "List items require exactly one paragraph in Rich Text 1.0.0.",
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

export function serializeRichTextDocument(
  document: RichTextDocument,
): SerializedRichTextDocument {
  return JSON.stringify(
    validateRichTextDocument(document),
  ) as SerializedRichTextDocument;
}

export function parseSerializedRichTextDocument(
  value: string,
): RichTextDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    issue("invalid_node", "$", "Rich text must be valid canonical JSON.");
  }
  return validateRichTextDocument(parsed as RichTextDocument);
}

export function createSerializedRichTextDocument(
  value: string,
): SerializedRichTextDocument {
  return serializeRichTextDocument(parseSerializedRichTextDocument(value));
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
          Number(block.attrs.level) < 2 ||
          Number(block.attrs.level) > 5
        ) {
          issue(
            "invalid_structure",
            `${path}.attrs.level`,
            "TipTap heading level must be an integer from 2 through 5.",
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
          assertOnlyKeys(block.attrs, ["start", "type"], `${path}.attrs`);
          if (block.attrs.start !== 1) {
            issue(
              "unsupported_attribute",
              `${path}.attrs.start`,
              "Only ordered lists beginning at 1 have a canonical representation.",
            );
          }
          if (
            block.attrs.type !== undefined &&
            block.attrs.type !== null &&
            block.attrs.type !== "1"
          ) {
            issue(
              "unsupported_attribute",
              `${path}.attrs.type`,
              'Only the default numeric ordered-list type ("1") has a canonical representation.',
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
          content: document.children.map((block): JsonObject =>
            visitRichTextBlock(block, {
              paragraph: toTipTapParagraph,
              heading: (heading) => ({
                  type: "heading",
                  attrs: { level: heading.level },
                  ...(heading.children.length === 0
                    ? {}
                    : { content: heading.children.map(toTipTapText) }),
                }),
              blockquote: (blockquote) => ({
                  type: "blockquote",
                  content: blockquote.children.map(toTipTapParagraph),
                }),
              bulletList: (list) => ({
                  type: "bulletList",
                  content: list.children.map((item) => ({
                    type: "listItem",
                    content: item.children.map(toTipTapParagraph),
                  })),
                }),
              orderedList: (list) => ({
                type: "orderedList",
                attrs: { start: 1, type: null },
                content: list.children.map((item) => ({
                  type: "listItem",
                  content: item.children.map(toTipTapParagraph),
                })),
              }),
            }),
          ),
        }),
  };
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\`*{}[\]()<>#+\-.!_|>&~])/gu, "\\$1");
}

function escapeMarkdownDestination(value: string): string {
  return value.replace(/([\\()&])/gu, "\\$1");
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
  const serialized = paragraph.children.map(serializeText).join("");
  if (serialized.startsWith("\t")) {
    return `&#9;${serialized.slice(1)}`;
  }
  if (serialized.startsWith("    ")) {
    return `&#32;${serialized.slice(1)}`;
  }
  return serialized;
}

export function serializeRichTextToMarkdown(
  document: RichTextDocument,
): string {
  validateRichTextDocument(document);
  const serializeList = (list: RichTextList) =>
    list.children
      .map((item, index) => {
        const marker = list.type === "bulletList" ? "-" : `${index + 1}.`;
        return `${marker} ${serializeParagraph(item.children[0]!)}`;
      })
      .join("\n");
  const blocks = document.children.map((block) =>
    visitRichTextBlock(block, {
      paragraph: serializeParagraph,
      heading: (heading) =>
        `${"#".repeat(heading.level)} ${heading.children
          .map(serializeText)
          .join("")}`,
      blockquote: (blockquote) =>
        blockquote.children
          .map((paragraph) => `> ${serializeParagraph(paragraph)}`)
          .join("\n>\n"),
      bulletList: serializeList,
      orderedList: serializeList,
    }),
  );
  return blocks.length === 0 ? "" : `${blocks.join("\n\n")}\n`;
}

function isEscapedAt(value: string, index: number): boolean {
  let backslashes = 0;
  for (
    let candidate = index - 1;
    candidate >= 0 && value[candidate] === "\\";
    candidate -= 1
  ) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function findUnescaped(value: string, needle: string, from: number): number {
  for (let index = from; index <= value.length - needle.length; index += 1) {
    if (
      value.slice(index, index + needle.length) === needle &&
      !isEscapedAt(value, index)
    ) {
      return index;
    }
  }
  return -1;
}

function unescapeMarkdown(value: string, path: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value.startsWith("&#32;", index)) {
      result += " ";
      index += "&#32;".length - 1;
      continue;
    }
    if (value.startsWith("&#9;", index)) {
      result += "\t";
      index += "&#9;".length - 1;
      continue;
    }
    if (value[index] !== "\\") {
      result += value[index];
      continue;
    }
    const escaped = value[index + 1];
    if (
      escaped === undefined ||
      !"\\`*{}[]()<>#+-.!_|>&~".includes(escaped)
    ) {
      issue(
        "serializer_ambiguity",
        path,
        "Markdown contains a non-canonical escape sequence.",
      );
    }
    result += escaped;
    index += 1;
  }
  return result;
}

function addInlineMark(
  children: ReadonlyArray<RichTextText>,
  mark: RichTextMark,
): RichTextText[] {
  return children.map((child) => ({
    ...child,
    marks: [...child.marks, mark].sort((left, right) => {
      const order = { bold: 0, italic: 1, link: 2 };
      const leftKind = typeof left === "string" ? left : left.type;
      const rightKind = typeof right === "string" ? right : right.type;
      return order[leftKind] - order[rightKind];
    }),
  }));
}

function parseMarkdownInline(value: string, path: string): RichTextText[] {
  const children: RichTextText[] = [];
  let plain = "";
  const flushPlain = () => {
    if (plain !== "") {
      children.push({
        type: "text",
        text: unescapeMarkdown(plain, path),
        marks: [],
      });
      plain = "";
    }
  };
  for (let index = 0; index < value.length; ) {
    if (value[index] === "\\") {
      if (value[index + 1] === undefined) {
        issue(
          "serializer_ambiguity",
          path,
          "Markdown ends with an incomplete escape.",
        );
      }
      plain += value.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (value[index] === "[") {
      const labelEnd = findUnescaped(value, "](", index + 1);
      if (labelEnd < 0) {
        issue("serializer_ambiguity", path, "Link syntax is incomplete.");
      }
      const destinationEnd = findUnescaped(value, ")", labelEnd + 2);
      if (destinationEnd < 0) {
        issue("serializer_ambiguity", path, "Link destination is incomplete.");
      }
      flushPlain();
      const href = unescapeMarkdown(
        value.slice(labelEnd + 2, destinationEnd),
        path,
      );
      if (!isSafeLink(href)) {
        issue("unsafe_link", path, "Markdown contains an unsafe link.");
      }
      children.push(
        ...addInlineMark(
          parseMarkdownInline(value.slice(index + 1, labelEnd), path),
          { type: "link", href },
        ),
      );
      index = destinationEnd + 1;
      continue;
    }
    const delimiter = value.startsWith("***", index)
      ? "***"
      : value.startsWith("**", index)
        ? "**"
        : value[index] === "*"
          ? "*"
          : undefined;
    if (delimiter !== undefined) {
      const end = findUnescaped(value, delimiter, index + delimiter.length);
      if (end < 0) {
        issue("serializer_ambiguity", path, "Emphasis syntax is incomplete.");
      }
      flushPlain();
      let marked = parseMarkdownInline(
        value.slice(index + delimiter.length, end),
        path,
      );
      if (delimiter === "***" || delimiter === "**") {
        marked = addInlineMark(marked, "bold");
      }
      if (delimiter === "***" || delimiter === "*") {
        marked = addInlineMark(marked, "italic");
      }
      children.push(...marked);
      index = end + delimiter.length;
      continue;
    }
    plain += value[index];
    index += 1;
  }
  flushPlain();
  return combineAdjacentText(children);
}

export function parseRichTextMarkdown(markdown: string): RichTextDocument {
  if (markdown === "") {
    return { version: RICH_TEXT_VERSION, type: "document", children: [] };
  }
  if (!markdown.endsWith("\n") || markdown.includes("\r")) {
    issue(
      "serializer_ambiguity",
      "$",
      "Canonical rich-text Markdown uses LF and one trailing newline.",
    );
  }
  const chunks = markdown.slice(0, -1).split("\n\n");
  const children = chunks.map((chunk, blockIndex): RichTextBlock => {
    const path = `$.blocks[${blockIndex}]`;
    const heading = /^(#{2,5}) (.*)$/u.exec(chunk);
    if (heading !== null) {
      return {
        type: "heading",
        level: heading[1]!.length as RichTextHeading["level"],
        children: parseMarkdownInline(heading[2]!, path),
      };
    }
    const lines = chunk.split("\n");
    if (lines.every((line) => line.startsWith("> ") || line === ">")) {
      const paragraphs = chunk.split("\n>\n");
      return {
        type: "blockquote",
        children: paragraphs.map((paragraph) => ({
          type: "paragraph",
          children: parseMarkdownInline(paragraph.slice(2), path),
        })),
      };
    }
    if (lines.every((line) => /^- /u.test(line))) {
      return {
        type: "bulletList",
        children: lines.map((line) => ({
          type: "listItem",
          children: [
            {
              type: "paragraph",
              children: parseMarkdownInline(line.slice(2), path),
            },
          ],
        })),
      };
    }
    if (lines.every((line, index) => line.startsWith(`${index + 1}. `))) {
      return {
        type: "orderedList",
        children: lines.map((line, index) => ({
          type: "listItem",
          children: [
            {
              type: "paragraph",
              children: parseMarkdownInline(
                line.slice(`${index + 1}. `.length),
                path,
              ),
            },
          ],
        })),
      };
    }
    if (lines.length !== 1) {
      issue(
        "serializer_ambiguity",
        path,
        "Markdown block structure is not canonical.",
      );
    }
    return {
      type: "paragraph",
      children: parseMarkdownInline(chunk, path),
    };
  });
  const document = validateRichTextDocument({
    version: RICH_TEXT_VERSION,
    type: "document",
    children,
  });
  if (serializeRichTextToMarkdown(document) !== markdown) {
    issue(
      "serializer_ambiguity",
      "$",
      "Markdown has more than one supported interpretation.",
    );
  }
  return document;
}
