import type { StarterKitOptions } from "@tiptap/starter-kit";

import {
  fromTipTapDocument,
  serializeRichTextDocument,
  type SerializedRichTextDocument,
} from "@humber-foundry/site-definition";

export const supportedRichTextStarterKitOptions = {
  code: false,
  codeBlock: false,
  hardBreak: false,
  heading: {
    levels: [2, 3, 4, 5],
  },
  horizontalRule: false,
  link: {
    openOnClick: false,
    autolink: false,
    linkOnPaste: false,
  },
  strike: false,
  underline: false,
} as const satisfies Partial<StarterKitOptions>;

export function serializeSupportedTipTapDocument(
  value: unknown,
): SerializedRichTextDocument | null {
  try {
    return serializeRichTextDocument(fromTipTapDocument(value));
  } catch {
    return null;
  }
}
