import { describe, expect, it } from "vitest";

import {
  RichTextValidationError,
  fromTipTapDocument,
  serializeRichTextToMarkdown,
  toTipTapDocument,
  validateRichTextDocument,
  type RichTextDocument,
  type RichTextText,
} from "./rich-text";

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
          attrs: { start: 1 },
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

  it("serializes supported content to stable Markdown", () => {
    expect(serializeRichTextToMarkdown(supportedDocument)).toBe(
      [
        "## Safe ***rich text***",
        "",
        "Read the [guide](/guide).",
        "",
        "- One",
        "- Two",
        "",
        "1. First",
        "",
        "> Keep it portable.",
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

  it.each([
    ["javascript:alert(1)", "unsafe_link"],
    ["data:text/html,<script>alert(1)</script>", "unsafe_link"],
    ["//attacker.example/path", "unsafe_link"],
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
});
