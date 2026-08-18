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
import Image from "@tiptap/extension-image";
import {
  isSafeRichTextLink,
  parseSerializedRichTextDocument,
  toTipTapDocument,
  type SerializedRichTextDocument,
} from "@humber-foundry/site-definition";

import { MediaPicker } from "./media-picker";
import type { EditorMediaContext } from "./change-photo-field";
import {
  serializeSupportedTipTapDocument,
  supportedRichTextStarterKitOptions,
} from "../src/rich-text-editor-state";

type RichTextEditorAccessibleName =
  | Readonly<{ label: string; labelledBy?: never }>
  | Readonly<{ label?: never; labelledBy: string }>;

function accessibleNameAttributes(
  label: string | undefined,
  labelledBy: string | undefined,
): Record<string, string> {
  return labelledBy === undefined
    ? { "aria-label": label ?? "" }
    : { "aria-labelledby": labelledBy };
}

export function RichTextEditor({
  id,
  value,
  disabled,
  describedBy,
  label,
  labelledBy,
  invalid,
  media,
  onChange,
  onValidationChange = () => undefined,
}: {
  id: string;
  value: SerializedRichTextDocument;
  disabled: boolean;
  describedBy: string;
  invalid: boolean;
  /**
   * When set, the toolbar offers "Add photo", which opens the shared media
   * picker and inserts the chosen photo as an inline image. Left unset, the
   * editor still draws any image already in the body, but offers no button.
   */
  media?: EditorMediaContext;
  onChange(value: SerializedRichTextDocument): void;
  onValidationChange?(invalid: boolean): void;
} & RichTextEditorAccessibleName) {
  const [validationMessage, setValidationMessage] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const validationMessageId = `${id}-validation`;
  const editorDescribedBy =
    validationMessage === ""
      ? describedBy
      : `${describedBy} ${validationMessageId}`;
  const latestValue = useRef(value);
  latestValue.current = value;
  const latestOnValidationChange = useRef(onValidationChange);
  latestOnValidationChange.current = onValidationChange;
  const locallyInvalid = useRef(false);
  function reportLocalValidation(invalid: boolean) {
    if (locallyInvalid.current === invalid) {
      return;
    }
    locallyInvalid.current = invalid;
    latestOnValidationChange.current(invalid);
  }
  const document = useMemo(
    () => parseSerializedRichTextDocument(value),
    [value],
  );
  const editorAccessibleName = useMemo(
    () => accessibleNameAttributes(label, labelledBy),
    [label, labelledBy],
  );
  const editor = useEditor({
    extensions: [
      StarterKit.configure(supportedRichTextStarterKitOptions),
      Image.configure({ inline: false, allowBase64: false }),
    ],
    content: toTipTapDocument(document),
    editable: !disabled,
    editorProps: {
      attributes: {
        id,
        ...editorAccessibleName,
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
        reportLocalValidation(true);
        return;
      }
      setValidationMessage("");
      reportLocalValidation(false);
      if (serialized === latestValue.current) {
        return;
      }
      onChange(serialized);
    },
  });

  useEffect(
    () => () => {
      if (locallyInvalid.current) {
        latestOnValidationChange.current(false);
      }
    },
    [],
  );

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
          ...editorAccessibleName,
          "aria-describedby": editorDescribedBy,
          "aria-invalid": String(invalid || validationMessage !== ""),
        },
      },
    });
  }, [
    editor,
    editorAccessibleName,
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
    if (current === null || current !== value) {
      editor.commands.setContent(toTipTapDocument(document), {
        emitUpdate: false,
      });
      setValidationMessage("");
      reportLocalValidation(false);
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
      setValidationMessage("");
      reportLocalValidation(false);
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    if (!isSafeRichTextLink(href)) {
      setValidationMessage(
        "Use an http, https, mailto, root-relative, or page-anchor link.",
      );
      reportLocalValidation(true);
      return;
    }
    setValidationMessage("");
    reportLocalValidation(false);
    editor
      .chain()
      .focus()
      .extendMarkRange("link")
      .setLink({ href })
      .run();
  }

  return (
    <div
      className="rich-text-editor rendered-rich-text"
      data-invalid={invalid || validationMessage !== ""}
    >
      <div
        className="rich-text-toolbar"
        role="toolbar"
        {...(labelledBy === undefined
          ? { "aria-label": `Text formatting for ${label}` }
          : { "aria-labelledby": labelledBy })}
      >
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
        {media === undefined ? null : (
          <button
            type="button"
            disabled={disabled}
            onClick={() => setPickerOpen(true)}
          >
            Add photo
          </button>
        )}
      </div>
      <EditorContent editor={editor} />
      {validationMessage === "" ? null : (
        <small id={validationMessageId} role="alert">{validationMessage}</small>
      )}
      {media === undefined ? null : (
        <MediaPicker
          open={pickerOpen}
          csrfToken={media.csrfToken}
          workspaceId={media.workspaceId}
          onChoose={(photo) => {
            if (editor === null) {
              return;
            }
            // The picker sets the photo; a separate prompt sets its
            // description, so alt text can be given per inline image. A
            // cancelled prompt leaves the image with no description.
            const description = window.prompt(
              "Describe this image for people who cannot see it. Leave blank for a decorative image.",
              "",
            );
            editor
              .chain()
              .focus()
              .setImage({
                src: photo.imageSrc,
                alt: description ?? "",
              })
              .run();
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
