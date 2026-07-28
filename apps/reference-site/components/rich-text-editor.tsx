"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  isSafeRichTextLink,
  parseSerializedRichTextDocument,
  toTipTapDocument,
  type SerializedRichTextDocument,
} from "@foundry/site-definition";

import {
  serializeSupportedTipTapDocument,
  supportedRichTextStarterKitOptions,
} from "../src/rich-text-editor-state";

export function RichTextEditor({
  id,
  value,
  disabled,
  describedBy,
  invalid,
  onChange,
}: {
  id: string;
  value: SerializedRichTextDocument;
  disabled: boolean;
  describedBy: string;
  invalid: boolean;
  onChange(value: SerializedRichTextDocument): void;
}) {
  const [validationMessage, setValidationMessage] = useState("");
  const validationMessageId = `${id}-validation`;
  const editorDescribedBy =
    validationMessage === ""
      ? describedBy
      : `${describedBy} ${validationMessageId}`;
  const latestValue = useRef(value);
  latestValue.current = value;
  const document = useMemo(
    () => parseSerializedRichTextDocument(value),
    [value],
  );
  const editor = useEditor({
    extensions: [
      StarterKit.configure(supportedRichTextStarterKitOptions),
    ],
    content: toTipTapDocument(document),
    editable: !disabled,
    editorProps: {
      attributes: {
        id,
        "aria-label": "Rendered rich text",
        "aria-describedby": editorDescribedBy,
        "aria-invalid": String(invalid || validationMessage !== ""),
      },
    },
    immediatelyRender: false,
    onUpdate: ({ editor: currentEditor }) => {
      const serialized = serializeSupportedTipTapDocument(
        currentEditor.getJSON(),
      );
      if (serialized === null) {
        setValidationMessage(
          "This edit contains unsupported or unsafe rich-text content.",
        );
        return;
      }
      if (serialized === latestValue.current) {
        return;
      }
      setValidationMessage("");
      onChange(serialized);
    },
  });

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [disabled, editor]);

  useEffect(() => {
    if (editor === null) {
      return;
    }
    editor.setOptions({
      editorProps: {
        ...editor.options.editorProps,
        attributes: {
          ...editor.options.editorProps.attributes,
          id,
          "aria-label": "Rendered rich text",
          "aria-describedby": editorDescribedBy,
          "aria-invalid": String(invalid || validationMessage !== ""),
        },
      },
    });
  }, [
    editor,
    editorDescribedBy,
    id,
    invalid,
    validationMessage,
  ]);

  useLayoutEffect(() => {
    if (editor === null) {
      return;
    }
    const current = serializeSupportedTipTapDocument(editor.getJSON());
    if (current === null) {
      return;
    }
    if (current !== value) {
      editor.commands.setContent(toTipTapDocument(document), {
        emitUpdate: false,
      });
    }
  }, [document, editor, value]);

  function setLink() {
    if (editor === null) {
      return;
    }
    const previous = editor.getAttributes("link").href;
    const href = window.prompt(
      "Link address (https, http, mailto, /path, or #anchor)",
      typeof previous === "string" ? previous : "",
    );
    if (href === null) {
      return;
    }
    if (href === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    if (!isSafeRichTextLink(href)) {
      setValidationMessage(
        "Use an http, https, mailto, root-relative, or page-anchor link.",
      );
      return;
    }
    editor
      .chain()
      .focus()
      .extendMarkRange("link")
      .setLink({ href })
      .run();
  }

  return (
    <div className="rich-text-editor rendered-rich-text">
      <div className="rich-text-toolbar" role="toolbar" aria-label="Text formatting">
        <button
          type="button"
          disabled={disabled}
          aria-pressed={editor?.isActive("bold") ?? false}
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          Bold
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-pressed={editor?.isActive("italic") ?? false}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        >
          Italic
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-pressed={editor?.isActive("heading", { level: 2 }) ?? false}
          onClick={() =>
            editor?.chain().focus().toggleHeading({ level: 2 }).run()
          }
        >
          Heading
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-pressed={editor?.isActive("bulletList") ?? false}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        >
          Bullets
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-pressed={editor?.isActive("orderedList") ?? false}
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
        >
          Numbered
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-pressed={editor?.isActive("blockquote") ?? false}
          onClick={() => editor?.chain().focus().toggleBlockquote().run()}
        >
          Quote
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-pressed={editor?.isActive("link") ?? false}
          onClick={setLink}
        >
          Link
        </button>
      </div>
      <EditorContent editor={editor} />
      {validationMessage === "" ? null : (
        <small id={validationMessageId} role="alert">{validationMessage}</small>
      )}
    </div>
  );
}
