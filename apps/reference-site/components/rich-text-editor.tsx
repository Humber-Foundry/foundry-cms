"use client";

import { useEffect, useState } from "react";

import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  fromTipTapDocument,
  isSafeRichTextLink,
  toTipTapDocument,
  type RichTextDocument,
} from "@foundry/site-definition";

export function RichTextEditor({
  id,
  value,
  disabled,
  describedBy,
  invalid,
  onChange,
}: {
  id: string;
  value: string;
  disabled: boolean;
  describedBy: string;
  invalid: boolean;
  onChange(value: string): void;
}) {
  const [validationMessage, setValidationMessage] = useState("");
  const document = JSON.parse(value) as RichTextDocument;
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        link: {
          openOnClick: false,
          autolink: false,
          linkOnPaste: false,
        },
      }),
    ],
    content: toTipTapDocument(document),
    editable: !disabled,
    immediatelyRender: false,
    onUpdate: ({ editor: currentEditor }) => {
      try {
        const canonical = fromTipTapDocument(currentEditor.getJSON());
        setValidationMessage("");
        onChange(JSON.stringify(canonical));
      } catch {
        setValidationMessage(
          "This edit contains unsupported or unsafe rich-text content.",
        );
      }
    },
  });

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [disabled, editor]);

  useEffect(() => {
    if (editor === null) {
      return;
    }
    const current = JSON.stringify(fromTipTapDocument(editor.getJSON()));
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
    <div
      id={id}
      className="rich-text-editor"
      aria-invalid={invalid || validationMessage !== ""}
      aria-describedby={describedBy}
    >
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
        <small role="alert">{validationMessage}</small>
      )}
    </div>
  );
}
