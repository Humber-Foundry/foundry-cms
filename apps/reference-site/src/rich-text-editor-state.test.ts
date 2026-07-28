import { describe, expect, it } from "vitest";

import {
  serializeSupportedTipTapDocument,
  supportedRichTextStarterKitOptions,
} from "./rich-text-editor-state";

describe("rich-text editor state", () => {
  it("keeps unsupported StarterKit content outside the editing schema", () => {
    expect(supportedRichTextStarterKitOptions).toEqual(
      expect.objectContaining({
        code: false,
        codeBlock: false,
        hardBreak: false,
        horizontalRule: false,
        strike: false,
        underline: false,
      }),
    );
  });

  it("returns an explicit invalid state instead of throwing on unsupported local JSON", () => {
    expect(
      serializeSupportedTipTapDocument({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Before" },
              { type: "hardBreak" },
              { type: "text", text: "After" },
            ],
          },
        ],
      }),
    ).toBeNull();
  });
});
