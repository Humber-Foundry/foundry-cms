import { HtmlRenderer, Parser } from "commonmark";
import { describe, expect, it } from "vitest";

import {
  RichTextValidationError,
  fromTipTapDocument,
  parseRichTextMarkdown,
  richTextDocumentHasVisibleText,
  serializeRichTextToMarkdown,
  toTipTapDocument,
  validateRichTextDocument,
  type RichTextDocument,
  type RichTextText,
} from "./rich-text";

const commonMarkParser = new Parser();
const commonMarkHtmlRenderer = new HtmlRenderer();

function renderCommonMark(markdown: string): string {
  return commonMarkHtmlRenderer.render(commonMarkParser.parse(markdown));
}

const supportedDocument: RichTextDocument = {
  version: "1.0.0",
  type: "document",
  children: [
    {
      type: "heading",
      level: 2,
      children: [
        { type: "text", text: "Safe ", marks: [] },
        {
          type: "text",
          text: "rich text",
          marks: ["bold", "italic"],
        },
      ],
    },
    {
      type: "paragraph",
      children: [
        { type: "text", text: "Read the ", marks: [] },
        {
          type: "text",
          text: "guide",
          marks: [{ type: "link", href: "/guide" }],
        },
        { type: "text", text: ".", marks: [] },
      ],
    },
    {
      type: "bulletList",
      children: [
        {
          type: "listItem",
          children: [
            {
              type: "paragraph",
              children: [{ type: "text", text: "One", marks: [] }],
            },
          ],
        },
        {
          type: "listItem",
          children: [
            {
              type: "paragraph",
              children: [{ type: "text", text: "Two", marks: [] }],
            },
          ],
        },
      ],
    },
    {
      type: "orderedList",
      children: [
        {
          type: "listItem",
          children: [
            {
              type: "paragraph",
              children: [{ type: "text", text: "First", marks: [] }],
            },
          ],
        },
      ],
    },
    {
      type: "blockquote",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", text: "Keep it portable.", marks: [] }],
        },
      ],
    },
  ],
};

describe("rich text contract", () => {
  it("round-trips supported TipTap JSON through an engine-neutral document", () => {
    const tipTap = toTipTapDocument(supportedDocument);

    expect(tipTap).toEqual({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [
            { type: "text", text: "Safe " },
            {
              type: "text",
              text: "rich text",
              marks: [{ type: "bold" }, { type: "italic" }],
            },
          ],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Read the " },
            {
              type: "text",
              text: "guide",
              marks: [{ type: "link", attrs: { href: "/guide" } }],
            },
            { type: "text", text: "." },
          ],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "One" }],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Two" }],
                },
              ],
            },
          ],
        },
        {
          type: "orderedList",
          attrs: { start: 1, type: null },
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "First" }],
                },
              ],
            },
          ],
        },
        {
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Keep it portable." }],
            },
          ],
        },
      ],
    });
    expect(fromTipTapDocument(tipTap)).toEqual(supportedDocument);
  });

  it("normalizes TipTap ordered-list defaults and rejects nonnumeric styles", () => {
    const tipTap = {
      type: "doc",
      content: [
        {
          type: "orderedList",
          attrs: { start: 1, type: null },
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "First" }],
                },
              ],
            },
          ],
        },
      ],
    };
    const document = fromTipTapDocument(tipTap);

    expect(
      fromTipTapDocument({
        ...tipTap,
        content: [
          {
            ...tipTap.content[0],
            attrs: { start: 1, type: "1" },
          },
        ],
      }),
    ).toEqual(document);
    expect(toTipTapDocument(document)).toEqual(tipTap);
    expect(() =>
      fromTipTapDocument({
        ...tipTap,
        content: [
          {
            ...tipTap.content[0],
            attrs: { start: 1, type: "a" },
          },
        ],
      }),
    ).toThrow(
      expect.objectContaining<Partial<RichTextValidationError>>({
        issues: [
          expect.objectContaining({
            code: "unsupported_attribute",
            path: "$.content[0].attrs.type",
          }),
        ],
      }),
    );
  });

  it("serializes supported content to stable Markdown", () => {
    expect(serializeRichTextToMarkdown(supportedDocument)).toBe(
      [
        "## Safe ***rich text***",
        "",
        "Read the [guide](/guide)\\.",
        "",
        "- One",
        "- Two",
        "",
        "1. First",
        "",
        "> Keep it portable\\.",
        "",
      ].join("\n"),
    );
  });

  it("escapes Markdown control characters in text and link labels", () => {
    expect(
      serializeRichTextToMarkdown({
        version: "1.0.0",
        type: "document",
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "text",
                text: "# [literal] *copy*",
                marks: [{ type: "link", href: "https://example.com/a_(b)" }],
              },
            ],
          },
        ],
      }),
    ).toBe("[\\# \\[literal\\] \\*copy\\*](https://example.com/a_\\(b\\))\n");
  });

  it("round-trips entity-looking text and link destinations literally", () => {
    const document: RichTextDocument = {
      version: "1.0.0",
      type: "document",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              text: "&copy; &#169; &#xA9;",
              marks: [
                {
                  type: "link",
                  href: "https://example.com/?a=1&copy;=2",
                },
              ],
            },
          ],
        },
      ],
    };

    const markdown = serializeRichTextToMarkdown(document);

    expect(markdown).toBe(
      "[\\&copy; \\&\\#169; \\&\\#xA9;](https://example.com/?a=1\\&copy;=2)\n",
    );
    expect(parseRichTextMarkdown(markdown)).toEqual(document);
    expect(serializeRichTextToMarkdown(parseRichTextMarkdown(markdown))).toBe(
      markdown,
    );
  });

  it.each([
    ["javascript:alert(1)", "unsafe_link"],
    ["data:text/html,<script>alert(1)</script>", "unsafe_link"],
    ["//attacker.example/path", "unsafe_link"],
    ["/\\attacker.example/path", "unsafe_link"],
  ])("rejects unsafe link %s", (href, code) => {
    const document = structuredClone(supportedDocument);
    const paragraph = document.children[1];
    if (paragraph?.type !== "paragraph") {
      throw new Error("test_fixture_invalid");
    }
    (paragraph.children as RichTextText[])[1] = {
      type: "text",
      text: "guide",
      marks: [{ type: "link", href }],
    };

    expect(() => validateRichTextDocument(document)).toThrow(
      expect.objectContaining<Partial<RichTextValidationError>>({
        name: "RichTextValidationError",
        issues: expect.arrayContaining([
          expect.objectContaining({ code }),
        ]),
      }),
    );
  });

  it("rejects unsupported and executable TipTap nodes explicitly", () => {
    expect(() =>
      fromTipTapDocument({
        type: "doc",
        content: [
          {
            type: "html",
            attrs: { content: "<script>alert(1)</script>" },
          },
        ],
      }),
    ).toThrow(
      expect.objectContaining<Partial<RichTextValidationError>>({
        issues: [
          expect.objectContaining({
            code: "unsupported_node",
            path: "$.content[0].type",
          }),
        ],
      }),
    );
  });

  it("rejects serializer ambiguity instead of guessing", () => {
    expect(() =>
      validateRichTextDocument({
        version: "1.0.0",
        type: "document",
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "text",
                text: "line one\nline two",
                marks: [],
              },
            ],
          },
        ],
      }),
    ).toThrow(
      expect.objectContaining<Partial<RichTextValidationError>>({
        issues: [
          expect.objectContaining({
            code: "ambiguous_text",
            path: "$.children[0].children[0].text",
          }),
        ],
      }),
    );
  });

  it("canonicalizes TipTap mark and text-node ordering", () => {
    expect(
      fromTipTapDocument({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "joined",
                marks: [{ type: "italic" }, { type: "bold" }],
              },
              {
                type: "text",
                text: " text",
                marks: [{ type: "bold" }, { type: "italic" }],
              },
            ],
          },
        ],
      }),
    ).toEqual({
      version: "1.0.0",
      type: "document",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              text: "joined text",
              marks: ["bold", "italic"],
            },
          ],
        },
      ],
    });
  });

  it("round-trips canonical Markdown back to the same engine-neutral AST", () => {
    const markdown = serializeRichTextToMarkdown(supportedDocument);

    expect(parseRichTextMarkdown(markdown)).toEqual(supportedDocument);
    expect(serializeRichTextToMarkdown(parseRichTextMarkdown(markdown))).toBe(
      markdown,
    );
  });

  it("escapes paragraph text that resembles a Markdown list marker", () => {
    const document: RichTextDocument = {
      version: "1.0.0",
      type: "document",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", text: "1. item", marks: [] }],
        },
      ],
    };

    expect(serializeRichTextToMarkdown(document)).toBe("1\\. item\n");
    expect(parseRichTextMarkdown("1\\. item\n")).toEqual(document);
  });

  it.each([
    ["~~~ code fence", "\\~\\~\\~ code fence\n"],
    ["    indented code", "&#32;   indented code\n"],
    ["\tindented code", "&#9;indented code\n"],
  ])(
    "round-trips paragraph text beginning with a CommonMark block marker: %s",
    (text, expectedMarkdown) => {
      const document: RichTextDocument = {
        version: "1.0.0",
        type: "document",
        children: [
          {
            type: "paragraph",
            children: [{ type: "text", text, marks: [] }],
          },
        ],
      };

      expect(serializeRichTextToMarkdown(document)).toBe(expectedMarkdown);
      expect(parseRichTextMarkdown(expectedMarkdown)).toEqual(document);
    },
  );

  it("round-trips text ending in a backslash inside formatting", () => {
    const document: RichTextDocument = {
      version: "1.0.0",
      type: "document",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", text: "path\\", marks: ["bold"] }],
        },
      ],
    };

    expect(parseRichTextMarkdown(serializeRichTextToMarkdown(document))).toEqual(
      document,
    );
  });

  it.each([" bold", "bold ", " "])(
    "rejects marked edge whitespace without a valid CommonMark representation: %j",
    (text) => {
      expect(() =>
        serializeRichTextToMarkdown({
          version: "1.0.0",
          type: "document",
          children: [
            {
              type: "paragraph",
              children: [{ type: "text", text, marks: ["bold"] }],
            },
          ],
        }),
      ).toThrow(
        expect.objectContaining<Partial<RichTextValidationError>>({
          issues: [
            expect.objectContaining({
              code: "serializer_ambiguity",
              path: "$.children[0].children[0].text",
            }),
          ],
        }),
      );
    },
  );

  it.each(["** **\n", "** bold **\n", "* italic *\n"])(
    "rejects non-flanking CommonMark emphasis: %j",
    (markdown) => {
      expect(() => parseRichTextMarkdown(markdown)).toThrow(
        expect.objectContaining<Partial<RichTextValidationError>>({
          issues: expect.arrayContaining([
            expect.objectContaining({ code: "serializer_ambiguity" }),
          ]),
        }),
      );
    },
  );

  it("rejects NUL before CommonMark replaces it with U+FFFD", () => {
    const markdown = "before\u0000after\n";
    expect(renderCommonMark(markdown)).toBe("<p>before�after</p>\n");
    expect(() =>
      serializeRichTextToMarkdown({
        version: "1.0.0",
        type: "document",
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "text",
                text: "before\u0000after",
                marks: [],
              },
            ],
          },
        ],
      }),
    ).toThrow(
      expect.objectContaining<Partial<RichTextValidationError>>({
        issues: [
          expect.objectContaining({
            code: "ambiguous_text",
            path: "$.children[0].children[0].text",
          }),
        ],
      }),
    );
    expect(() => parseRichTextMarkdown(markdown)).toThrow(
      expect.objectContaining<Partial<RichTextValidationError>>({
        issues: [
          expect.objectContaining({
            code: "ambiguous_text",
          }),
        ],
      }),
    );
  });

  it.each(["\uD800", "\uDFFF"])(
    "rejects an unpaired UTF-16 surrogate before byte encoding: %j",
    (surrogate) => {
      expect([...new TextEncoder().encode(surrogate)]).toEqual([
        0xef, 0xbf, 0xbd,
      ]);
      expect(JSON.stringify(surrogate)).not.toBe(JSON.stringify("�"));
      expect(() =>
        serializeRichTextToMarkdown({
          version: "1.0.0",
          type: "document",
          children: [
            {
              type: "paragraph",
              children: [
                {
                  type: "text",
                  text: surrogate,
                  marks: [],
                },
              ],
            },
          ],
        }),
      ).toThrow(
        expect.objectContaining<Partial<RichTextValidationError>>({
          issues: [
            expect.objectContaining({
              code: "ambiguous_text",
              path: "$.children[0].children[0].text",
            }),
          ],
        }),
      );
    },
  );

  it("rejects an unpaired UTF-16 surrogate in a link before byte encoding", () => {
    const href = "https://example.com/\uD800";
    expect(new TextDecoder().decode(new TextEncoder().encode(href))).toBe(
      "https://example.com/�",
    );
    expect(() =>
      serializeRichTextToMarkdown({
        version: "1.0.0",
        type: "document",
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "text",
                text: "link",
                marks: [{ type: "link", href }],
              },
            ],
          },
        ],
      }),
    ).toThrow(
      expect.objectContaining<Partial<RichTextValidationError>>({
        issues: [
          expect.objectContaining({
            code: "unsafe_link",
            path: "$.children[0].children[0].marks[0].href",
          }),
        ],
      }),
    );
  });

  it.each(["\u200B", "\u2060", "\u0007"])(
    "does not count format/control-only text as visible: %j",
    (text) => {
      expect(
        richTextDocumentHasVisibleText({
          version: "1.0.0",
          type: "document",
          children: [
            {
              type: "paragraph",
              children: [{ type: "text", text, marks: [] }],
            },
          ],
        }),
      ).toBe(false);
    },
  );

  it.each(["a\u200Bb", "👩‍💻"])(
    "preserves visible sequences containing format controls: %j",
    (text) => {
      expect(
        richTextDocumentHasVisibleText({
          version: "1.0.0",
          type: "document",
          children: [
            {
              type: "paragraph",
              children: [{ type: "text", text, marks: [] }],
            },
          ],
        }),
      ).toBe(true);
    },
  );

  it.each([
    {
      name: "opening strong emphasis after alphanumeric text",
      children: [
        { type: "text", text: "a", marks: [] },
        { type: "text", text: "!b", marks: ["bold"] },
      ],
      previousMarkdown: "a**\\!b**\n",
      previousHtml: "<p>a**!b**</p>\n",
      issuePath: "$.children[0].children[1].text",
    },
    {
      name: "closing emphasis before alphanumeric text",
      children: [
        { type: "text", text: "b!", marks: ["italic"] },
        { type: "text", text: "a", marks: [] },
      ],
      previousMarkdown: "*b\\!*a\n",
      previousHtml: "<p>*b!*a</p>\n",
      issuePath: "$.children[0].children[0].text",
    },
    {
      name: "opening emphasis in a joined delimiter run",
      children: [
        { type: "text", text: "a", marks: ["bold"] },
        { type: "text", text: "!b", marks: ["italic"] },
      ],
      previousMarkdown: "**a***\\!b*\n",
      previousHtml: "<p><strong>a</strong>*!b*</p>\n",
      issuePath: "$.children[0].children[1].text",
    },
    {
      name: "closing emphasis in a joined delimiter run",
      children: [
        { type: "text", text: "b!", marks: ["italic"] },
        { type: "text", text: "a", marks: ["bold"] },
      ],
      previousMarkdown: "*b\\!***a**\n",
      previousHtml: "<p>*b!*<strong>a</strong></p>\n",
      issuePath: "$.children[0].children[0].text",
    },
  ] satisfies ReadonlyArray<{
    name: string;
    children: RichTextText[];
    previousMarkdown: string;
    previousHtml: string;
    issuePath: string;
  }>)(
    "rejects $name when CommonMark cannot preserve the marks",
    ({ children, previousMarkdown, previousHtml, issuePath }) => {
      expect(renderCommonMark(previousMarkdown)).toBe(previousHtml);
      expect(() =>
        serializeRichTextToMarkdown({
          version: "1.0.0",
          type: "document",
          children: [{ type: "paragraph", children }],
        }),
      ).toThrow(
        expect.objectContaining<Partial<RichTextValidationError>>({
          issues: [
            expect.objectContaining({
              code: "serializer_ambiguity",
              path: issuePath,
            }),
          ],
        }),
      );
    },
  );

  it.each([
    {
      name: "bold to bold-italic to italic",
      children: [
        { type: "text", text: "a", marks: ["bold"] },
        { type: "text", text: "b", marks: ["bold", "italic"] },
        { type: "text", text: "c", marks: ["italic"] },
      ],
      previousMarkdown: "**a*****b****c*\n",
      previousHtml:
        "<p><strong>a</strong>***b***<em>c</em></p>\n",
    },
    {
      name: "italic to bold-italic to bold",
      children: [
        { type: "text", text: "a", marks: ["italic"] },
        { type: "text", text: "b", marks: ["bold", "italic"] },
        { type: "text", text: "c", marks: ["bold"] },
      ],
      previousMarkdown: "*a****b*****c**\n",
      previousHtml:
        "<p><em>a</em>***b***<strong>c</strong></p>\n",
    },
  ] satisfies ReadonlyArray<{
    name: string;
    children: RichTextText[];
    previousMarkdown: string;
    previousHtml: string;
  }>)(
    "rejects the multi-node $name transition that CommonMark reinterprets",
    ({ children, previousMarkdown, previousHtml }) => {
      expect(renderCommonMark(previousMarkdown)).toBe(previousHtml);
      expect(() =>
        serializeRichTextToMarkdown({
          version: "1.0.0",
          type: "document",
          children: [{ type: "paragraph", children }],
        }),
      ).toThrow(
        expect.objectContaining<Partial<RichTextValidationError>>({
          issues: [
            expect.objectContaining({
              code: "serializer_ambiguity",
              path: "$.children[0].children[2].marks",
            }),
          ],
        }),
      );
    },
  );

  it.each([
    {
      name: "punctuation at a line boundary",
      children: [{ type: "text", text: "!b!", marks: ["bold"] }],
      markdown: "**\\!b\\!**\n",
      html: "<p><strong>!b!</strong></p>\n",
    },
    {
      name: "punctuation on both sides of an opening delimiter",
      children: [
        { type: "text", text: "!", marks: [] },
        { type: "text", text: "!b", marks: ["bold"] },
      ],
      markdown: "\\!**\\!b**\n",
      html: "<p>!<strong>!b</strong></p>\n",
    },
    {
      name: "joined bold and italic delimiter runs",
      children: [
        { type: "text", text: "a", marks: ["bold"] },
        { type: "text", text: "b", marks: ["italic"] },
      ],
      markdown: "**a***b*\n",
      html: "<p><strong>a</strong><em>b</em></p>\n",
    },
    {
      name: "punctuation-flanked joined delimiter runs",
      children: [
        { type: "text", text: "a!", marks: ["bold"] },
        { type: "text", text: "!b", marks: ["italic"] },
      ],
      markdown: "**a\\!***\\!b*\n",
      html: "<p><strong>a!</strong><em>!b</em></p>\n",
    },
  ] satisfies ReadonlyArray<{
    name: string;
    children: RichTextText[];
    markdown: string;
    html: string;
  }>)(
    "preserves valid CommonMark formatting for $name",
    ({ children, markdown, html }) => {
      const serialized = serializeRichTextToMarkdown({
        version: "1.0.0",
        type: "document",
        children: [{ type: "paragraph", children }],
      });

      expect(serialized).toBe(markdown);
      expect(renderCommonMark(serialized)).toBe(html);
    },
  );

  it("never accepts sampled inline sequences that CommonMark reinterprets", () => {
    const texts = ["a", "!a", "a!", "!", "(a)", "“a”"];
    const markSets = [
      [],
      ["bold"],
      ["italic"],
      ["bold", "italic"],
    ] satisfies ReadonlyArray<RichTextText["marks"]>;
    const expectedHtml = (node: RichTextText) => {
      const text = node.text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
      if (node.marks.includes("bold") && node.marks.includes("italic")) {
        return `<em><strong>${text}</strong></em>`;
      }
      if (node.marks.includes("bold")) {
        return `<strong>${text}</strong>`;
      }
      return node.marks.includes("italic") ? `<em>${text}</em>` : text;
    };
    const expectCommonMarkToPreserve = (children: RichTextText[]) => {
      let markdown: string;
      try {
        markdown = serializeRichTextToMarkdown({
          version: "1.0.0",
          type: "document",
          children: [{ type: "paragraph", children }],
        });
      } catch (error) {
        expect(error).toBeInstanceOf(RichTextValidationError);
        return;
      }
      expect(renderCommonMark(markdown), markdown).toBe(
        `<p>${children.map(expectedHtml).join("")}</p>\n`,
      );
    };

    for (const leftText of texts) {
      for (const leftMarks of markSets) {
        for (const rightText of texts) {
          for (const rightMarks of markSets) {
            if (JSON.stringify(leftMarks) === JSON.stringify(rightMarks)) {
              continue;
            }
            const children: RichTextText[] = [
              {
                type: "text",
                text: leftText,
                marks: leftMarks,
              },
              {
                type: "text",
                text: rightText,
                marks: rightMarks,
              },
            ];
            expectCommonMarkToPreserve(children);
          }
        }
      }
    }

    const tripleTexts = texts.slice(0, 4);
    for (const leftText of tripleTexts) {
      for (const leftMarks of markSets) {
        for (const middleText of tripleTexts) {
          for (const middleMarks of markSets) {
            for (const rightText of tripleTexts) {
              for (const rightMarks of markSets) {
                expectCommonMarkToPreserve([
                  {
                    type: "text",
                    text: leftText,
                    marks: leftMarks,
                  },
                  {
                    type: "text",
                    text: middleText,
                    marks: middleMarks,
                  },
                  {
                    type: "text",
                    text: rightText,
                    marks: rightMarks,
                  },
                ]);
              }
            }
          }
        }
      }
    }
  });

  it.each([
    ["[run](javascript:alert\\(1\\))\n", "unsafe_link"],
    ["<script>alert(1)</script>\n", "serializer_ambiguity"],
    ["- item\ncontinuation\n", "serializer_ambiguity"],
  ])("rejects non-canonical Markdown %s", (markdown, code) => {
    expect(() => parseRichTextMarkdown(markdown)).toThrow(
      expect.objectContaining<Partial<RichTextValidationError>>({
        issues: expect.arrayContaining([
          expect.objectContaining({ code }),
        ]),
      }),
    );
  });

  it("rejects unknown contract versions", () => {
    expect(() =>
      validateRichTextDocument({
        ...supportedDocument,
        version: "2.0.0",
      } as unknown as RichTextDocument),
    ).toThrow(
      expect.objectContaining<Partial<RichTextValidationError>>({
        issues: [
          expect.objectContaining({
            code: "unsupported_version",
            path: "$.version",
          }),
        ],
      }),
    );
  });

  it("rejects heading levels outside the contextual design system", () => {
    expect(() =>
      fromTipTapDocument({
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 1 },
            content: [{ type: "text", text: "Page title" }],
          },
        ],
      }),
    ).toThrow(
      expect.objectContaining<Partial<RichTextValidationError>>({
        issues: [
          expect.objectContaining({
            code: "invalid_structure",
            path: "$.content[0].attrs.level",
          }),
        ],
      }),
    );
  });
});
