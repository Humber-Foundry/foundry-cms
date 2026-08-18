"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  createUsePuck,
  Puck,
  registerOverlayPortal,
  type Config,
  type Data,
} from "@puckeditor/core";

import {
  parseSerializedRichTextDocument,
  referencedPageComponentIds,
  serializeRichTextDocument,
  siteDesignAttributes,
  type CallToActionSection,
  type PageComponentField,
  type PageSection,
  type SiteDefinition,
} from "@humber-foundry/site-definition";

import { definitionToPuckData, puckDataToDefinition } from "../src/page-composition-puck";
import { CanvasImageField, type OpenPhotoPicker } from "./canvas-image-field";
import { ChangePhotoField, type EditorMediaContext } from "./change-photo-field";
import { InlineText } from "./inline-text";
import type { ChosenPhoto } from "./media-gallery-item";
import { MediaPicker } from "./media-picker";
import type {
  InlineImageRenderer,
  InlineTextRenderer,
} from "../foundry/page-component-renderers";
import { RichTextEditor } from "./rich-text-editor";
import { SiteSection } from "./site-renderer";
import {
  asRegisteredPageSection,
  createPuckField,
  inlineEditedImageFields,
  inlineEditedTextFields,
  installedPageComponentRegistry,
  type InstalledPageComponentRegistration,
} from "../foundry/page-components";

function DesignScopedSection({
  definition,
  section,
}: {
  definition: SiteDefinition;
  section: PageSection;
}) {
  return (
    <div className="site-canvas" {...siteDesignAttributes(definition.design)}>
      <SiteSection section={section} definition={definition} editingSurface />
    </div>
  );
}

/** Set one dot-path field ("principles.2.text") in a props object, immutably. */
function setAtPath(
  value: unknown,
  segments: ReadonlyArray<string>,
  next: string,
): unknown {
  if (segments.length === 0) return next;
  const [head, ...rest] = segments;
  if (Array.isArray(value)) {
    const index = Number(head);
    return value.map((item, at) =>
      at === index ? setAtPath(item, rest, next) : item,
    );
  }
  if (typeof value === "object" && value !== null) {
    return {
      ...(value as Record<string, unknown>),
      [head!]: setAtPath((value as Record<string, unknown>)[head!], rest, next),
    };
  }
  return value;
}

/**
 * A registered section on the canvas. While it is the selected section, its
 * text renders editable in place — click into a sentence and type; the value
 * commits when focus leaves it. Selection is the unlock, so a stray click on
 * an unselected section cannot change words by mistake.
 */
function EditableRegisteredSection({
  definition,
  section,
  disabled,
  media,
  openPhotoPicker,
}: {
  definition: SiteDefinition;
  section: PageSection & Readonly<{ type: "registered" }>;
  disabled: boolean;
  media: EditorMediaContext | undefined;
  openPhotoPicker: OpenPhotoPicker;
}) {
  const dispatch = useVisualPuck((state) => state.dispatch);
  const getSelectorForId = useVisualPuck((state) => state.getSelectorForId);
  const selected = useVisualPuck((state) => state.appState.ui.itemSelector);

  const selector = getSelectorForId(section.id);
  const isSelected =
    !disabled &&
    selector !== undefined &&
    selected !== null &&
    selected.index === selector.index &&
    (selected.zone ?? rootZone) === (selector.zone ?? rootZone);

  // One commit path for everything edited on the page itself. The schema
  // decides what is allowed; a refused value — emptied text, a malformed
  // destination — reverts in the editor instead of entering the canvas and
  // breaking the section's render.
  const commitField = (path: string, next: string): boolean => {
    const liveSelector = getSelectorForId(section.id);
    if (liveSelector === undefined) return false;
    const nextProps = setAtPath(
      section.props,
      path.split("."),
      next,
    ) as Record<string, unknown>;
    const registration =
      installedPageComponentRegistry.components[section.component];
    if (
      registration === undefined ||
      !registration.validate({ ...section, props: nextProps }).ok
    ) {
      return false;
    }
    dispatch({
      type: "replace",
      destinationIndex: liveSelector.index,
      destinationZone: liveSelector.zone,
      data: {
        type: section.component,
        props: {
          id: section.id,
          type: section.type,
          component: section.component,
          ...nextProps,
        },
      },
      recordHistory: true,
    });
    return true;
  };

  const inlineText: InlineTextRenderer | undefined = isSelected
    ? (path, value, options) => (
        <InlineText
          key={path}
          path={path}
          value={value}
          multiline={options?.multiline ?? false}
          label={options?.label ?? path}
          onCommit={(next) => commitField(path, next)}
        />
      )
    : undefined;

  // A photo is changed on the image itself, not in the side panel. The control
  // appears only while the section is selected and the picker's site context is
  // present; otherwise the section draws its plain photo.
  const inlineImage: InlineImageRenderer | undefined =
    isSelected && media !== undefined
      ? (path, displaySrc, options) => (
          <CanvasImageField
            key={path}
            displaySrc={displaySrc}
            alt={options.alt}
            openPhotoPicker={openPhotoPicker}
            onChange={(next) => commitField(path, next)}
          />
        )
      : undefined;

  return (
    <div className="site-canvas" {...siteDesignAttributes(definition.design)}>
      <SiteSection
        section={section}
        definition={definition}
        inlineText={inlineText}
        inlineImage={inlineImage}
        editingSurface
      />
    </div>
  );
}

function newStableComponentId(type: string): string {
  const typeSlug = type.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
  return `section_${typeSlug}_${crypto.randomUUID().replaceAll("-", "")}`;
}

const useVisualPuck = createUsePuck();
const ignoreRichTextValidation = () => undefined;
const hiddenField = Object.freeze({
  type: "custom" as const,
  visible: false,
  render: () => <></>,
});

function RenderedCallToActionSection({
  definition,
  section,
  disabled,
  onValidationChange,
}: {
  definition: SiteDefinition;
  section: CallToActionSection;
  disabled: boolean;
  onValidationChange(source: string, invalid: boolean): void;
}) {
  const dispatch = useVisualPuck((state) => state.dispatch);
  const getSelectorForId = useVisualPuck((state) => state.getSelectorForId);
  const portalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (portalRef.current === null) return;
    return registerOverlayPortal(portalRef.current, { disableDragOnFocus: true });
  }, []);

  return (
    <div className="site-canvas" {...siteDesignAttributes(definition.design)}>
      <SiteSection
        section={section}
        definition={definition}
        callToActionBody={
          <div
            ref={portalRef}
            data-rendered-rich-text-editor={section.id}
            onClick={(event) => event.stopPropagation()}
          >
            <RichTextEditor
              id={`${section.id}-rendered-body-editor`}
              value={serializeRichTextDocument(section.body)}
              disabled={disabled}
              invalid={false}
              describedBy={`${section.id}_title`}
              label="Body"
              onChange={(nextValue) => {
                const selector = getSelectorForId(section.id);
                if (selector === undefined) return;
                dispatch({
                  type: "replace",
                  destinationIndex: selector.index,
                  destinationZone: selector.zone,
                  data: {
                    type: "callToAction",
                    props: {
                      ...section,
                      body: parseSerializedRichTextDocument(nextValue),
                    },
                  },
                  recordHistory: true,
                });
              }}
              onValidationChange={(invalid) =>
                onValidationChange(`${section.id}.body.rendered`, invalid)
              }
            />
          </div>
        }
      />
    </div>
  );
}

const rootZone = "root:default-zone";

/**
 * Puck caches each section's resolved permissions. The config's permission
 * getter reads live state, but the cache only refreshes when asked — so when
 * the definition changes (a section becoming referenced makes it protected),
 * the cache is told to re-resolve. Without this, Puck's own overlay could
 * offer Delete on a section the schema no longer allows removing.
 */
function PermissionRefresher({ definition }: { definition: SiteDefinition }) {
  const refreshPermissions = useVisualPuck((state) => state.refreshPermissions);
  useEffect(() => {
    refreshPermissions();
  }, [definition, refreshPermissions]);
  return null;
}

/**
 * The actions for whichever section is selected in the page. They sit at the
 * top of the side panel, directly above that section's fields, so selecting a
 * section brings everything about it to one place. There is no separate
 * arrange-the-page list: the page itself is the list.
 */
function SelectedSectionActions({
  disabled,
  protectedComponentIds,
}: {
  disabled: boolean;
  protectedComponentIds: ReadonlySet<string>;
}) {
  const dispatch = useVisualPuck((state) => state.dispatch);
  const selected = useVisualPuck((state) => state.appState.ui.itemSelector);
  const content = useVisualPuck((state) => state.appState.data.content);
  const barRef = useRef<HTMLDivElement>(null);

  // On a phone the panel sits below the canvas, so selecting a section looked
  // like nothing happened. Nudge the panel into view — nearest edge only, so
  // the tapped section stays on screen.
  const selectionKey =
    selected === null ? null : `${selected.zone ?? rootZone}:${selected.index}`;
  useEffect(() => {
    if (selectionKey === null || barRef.current === null) return;
    if (!window.matchMedia("(max-width: 60rem)").matches) return;
    barRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selectionKey]);

  if (
    selected === null ||
    (selected.zone !== undefined && selected.zone !== rootZone)
  ) {
    return (
      <p className="section-actions-hint">
        Select a section in the page to edit or move it.
      </p>
    );
  }

  const index = selected.index;
  const item = content[index];
  if (item === undefined) {
    return null;
  }
  const label =
    installedPageComponentRegistry.components[item.type]?.label ?? item.type;
  const id = String(item.props.id);
  const moveSelected = (destinationIndex: number) => {
    dispatch({
      type: "move",
      sourceIndex: index,
      sourceZone: rootZone,
      destinationIndex,
      destinationZone: rootZone,
      recordHistory: true,
    });
    // Puck clears the selection on move; the owner is still working with the
    // same section, so it stays selected at its new place.
    dispatch({
      type: "setUi",
      ui: { itemSelector: { index: destinationIndex, zone: rootZone } },
    });
  };

  return (
    <div
      className="section-actions"
      role="group"
      aria-label={`${label} section`}
      ref={barRef}
    >
      <span className="section-actions-label">{label}</span>
      <span className="section-actions-buttons">
        <button
          type="button"
          disabled={disabled || index === 0}
          aria-label="Move section up"
          title="Move section up"
          onClick={() => moveSelected(index - 1)}
        >
          ↑
        </button>
        <button
          type="button"
          disabled={disabled || index === content.length - 1}
          aria-label="Move section down"
          title="Move section down"
          onClick={() => moveSelected(index + 1)}
        >
          ↓
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-label="Duplicate section"
          onClick={() => {
            dispatch({
              type: "duplicate",
              sourceIndex: index,
              sourceZone: rootZone,
              recordHistory: true,
            });
            // The original stays selected; the copy sits directly under it.
            dispatch({
              type: "setUi",
              ui: { itemSelector: { index, zone: rootZone } },
            });
          }}
        >
          Duplicate
        </button>
        <button
          type="button"
          disabled={disabled || protectedComponentIds.has(id)}
          aria-label="Remove section"
          onClick={() => {
            dispatch({
              type: "remove",
              index,
              zone: rootZone,
              recordHistory: true,
            });
            dispatch({ type: "setUi", ui: { itemSelector: null } });
          }}
        >
          Remove
        </button>
      </span>
    </div>
  );
}

/**
 * The one place a section is added. The new section lands after the selected
 * one — or at the end when nothing is selected — and becomes the selection, so
 * its fields are immediately in front of the owner.
 */
function AddSectionMenu({ disabled }: { disabled: boolean }) {
  const dispatch = useVisualPuck((state) => state.dispatch);
  const selected = useVisualPuck((state) => state.appState.ui.itemSelector);
  const contentLength = useVisualPuck((state) => state.appState.data.content.length);
  const menuRef = useRef<HTMLDetailsElement>(null);

  const destinationIndex =
    selected === null || (selected.zone !== undefined && selected.zone !== rootZone)
      ? contentLength
      : selected.index + 1;

  return (
    <details className="add-section-menu" ref={menuRef}>
      <summary aria-label="Add section">+ Add section</summary>
      <div role="group" aria-label="Section to add">
        {installedPageComponentRegistry.allowedComponents.map((type) => (
          <button
            key={type}
            type="button"
            disabled={disabled}
            onClick={() => {
              dispatch({
                type: "insert",
                componentType: type,
                destinationIndex,
                destinationZone: rootZone,
                id: newStableComponentId(type),
                recordHistory: true,
              });
              dispatch({
                type: "setUi",
                ui: { itemSelector: { index: destinationIndex, zone: rootZone } },
              });
              if (menuRef.current !== null) {
                menuRef.current.open = false;
              }
            }}
          >
            {installedPageComponentRegistry.components[type]!.label}
          </button>
        ))}
      </div>
    </details>
  );
}

function editorField(
  field: PageComponentField,
  onValidationChange: (source: string, invalid: boolean) => void,
  getMediaContext: () => EditorMediaContext | undefined,
): Record<string, unknown> {
  if (field.editable === false) return hiddenField;
  if (field.control === "image") {
    const media = getMediaContext();
    // Without the picker's site context (a canvas-less surface) there is no
    // safe swap, so fall back to the plain field rather than a dead button.
    if (media === undefined) return createPuckField(field);
    return {
      type: "custom",
      label: field.label,
      render: ({
        onChange,
        value,
      }: {
        onChange(value: unknown): void;
        value: unknown;
      }) => (
        <ChangePhotoField
          label={field.label}
          value={typeof value === "string" ? value : ""}
          onChange={onChange}
          media={media}
        />
      ),
    };
  }
  if (field.control !== "richText") return createPuckField(field);
  return {
    type: "custom",
    label: field.label,
    render: ({ name, onChange, value }: {
      name: string;
      onChange(value: unknown): void;
      value: CallToActionSection["body"];
    }) => (
      <RichTextEditor
        id={`${name}-editor`}
        value={serializeRichTextDocument(value)}
        disabled={false}
        invalid={false}
        describedBy={`${name}-help`}
        label={field.label}
        onChange={(nextValue) => onChange(parseSerializedRichTextDocument(nextValue))}
        onValidationChange={(invalid) => onValidationChange(name, invalid)}
      />
    ),
  };
}

function puckPropsToSection(
  registration: InstalledPageComponentRegistration,
  defaultSection: PageSection,
  props: Record<string, unknown>,
): PageSection {
  if (defaultSection.type === "registered") {
    return asRegisteredPageSection(registration.type, props);
  }
  return {
    id: String(props.id),
    type: registration.type,
    ...Object.fromEntries(
      Object.keys(registration.fields).map((key) => [key, props[key]]),
    ),
  } as unknown as PageSection;
}

/**
 * Build the Puck config once per mount. Everything that changes while editing
 * — the working definition, the protected sections, the disabled state — is
 * read through getters, because giving Puck a new config object resets its UI
 * state and throws away the owner's selection mid-edit.
 */
export function createVisualComponentConfig(
  getProtectedComponentIds: () => ReadonlySet<string>,
  getDefinition: () => SiteDefinition,
  onValidationChange: (source: string, invalid: boolean) => void = ignoreRichTextValidation,
  getDisabled: () => boolean = () => false,
  getMediaContext: () => EditorMediaContext | undefined = () => undefined,
  getOpenPhotoPicker: () => OpenPhotoPicker = () => () => undefined,
): Config {
  // A photo is changed on the image itself when the canvas has the picker's
  // site context, so its field leaves the side panel — one photo, one place to
  // change it, and no control colliding with the panel's section label.
  const canvasImageEditing = getMediaContext() !== undefined;
  const components = Object.fromEntries(
    installedPageComponentRegistry.allowedComponents.map((type) => {
      const registration = installedPageComponentRegistry.components[type]!;
      const id = `section_new_${type.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`)}`;
      const defaultSection = registration.createDefault(id, getDefinition());
      const defaultProps = defaultSection.type === "registered"
        ? {
            id: defaultSection.id,
            type: defaultSection.type,
            component: defaultSection.component,
            ...defaultSection.props,
          }
        : defaultSection;
      // Fields the renderer edits in place stay out of the panel: each piece
      // of text gets exactly one editing surface. Arrays keep their panel
      // controls because items are added, removed and reordered there.
      const inlineCovered = inlineEditedTextFields[type] ?? new Set<string>();
      const inlineImageCovered =
        inlineEditedImageFields[type] ?? new Set<string>();
      const fields = {
        id: hiddenField,
        type: hiddenField,
        ...(defaultSection.type === "registered" ? { component: hiddenField } : {}),
        ...Object.fromEntries(
          Object.entries(registration.fields).map(([key, field]) => [
            key,
            inlineCovered.has(key) ||
            (canvasImageEditing && inlineImageCovered.has(key))
              ? hiddenField
              : editorField(field, onValidationChange, getMediaContext),
          ]),
        ),
      };
      return [
        type,
        {
          label: registration.label,
          fields,
          defaultProps,
          render: (props: Record<string, unknown>) => {
            const section = puckPropsToSection(registration, defaultSection, props);
            if (section.type === "callToAction") {
              return <RenderedCallToActionSection definition={getDefinition()} section={section} disabled={getDisabled()} onValidationChange={onValidationChange} />;
            }
            if (section.type === "registered") {
              return <EditableRegisteredSection definition={getDefinition()} section={section} disabled={getDisabled()} media={getMediaContext()} openPhotoPicker={getOpenPhotoPicker()} />;
            }
            return <DesignScopedSection definition={getDefinition()} section={section} />;
          },
          resolvePermissions: (data: { props: { id: string } }) => ({
            delete: !getProtectedComponentIds().has(data.props.id),
          }),
        },
      ];
    }),
  );
  return {
    components,
    // The page's root carries no editable fields of its own; without this Puck
    // offers its built-in "title" input when nothing is selected.
    root: { fields: {} },
  } as Config;
}

/** The side panel body when no section is selected. */
function PanelWhenEmpty({ children }: { children?: ReactNode }) {
  const selected = useVisualPuck((state) => state.appState.ui.itemSelector);
  if (selected !== null) return null;
  return <div className="editor-side-page">{children}</div>;
}

/**
 * The selected section's fields; hidden — not unmounted — when nothing is
 * selected, because Puck's field state belongs to its mounted form.
 */
function PanelFields() {
  const selected = useVisualPuck((state) => state.appState.ui.itemSelector);
  return (
    <div
      className="editor-side-fields"
      style={selected === null ? { display: "none" } : undefined}
    >
      <Puck.Fields />
    </div>
  );
}

export function VisualComponentEditor({
  definition,
  disabled,
  onChange,
  onValidationChange = ignoreRichTextValidation,
  iframeEnabled = true,
  panelWhenEmpty,
  media,
}: {
  definition: SiteDefinition;
  disabled: boolean;
  onChange(definition: SiteDefinition): void;
  onValidationChange?(source: string, invalid: boolean): void;
  iframeEnabled?: boolean;
  /**
   * What the side panel shows when no section is selected — the page-level
   * settings, in practice, so the panel is never a dead surface.
   */
  panelWhenEmpty?: ReactNode;
  /**
   * The site context the "Change photo" picker needs. Absent on canvas-less
   * surfaces, where image fields fall back to a plain address field.
   */
  media?: EditorMediaContext;
}) {
  const initialData = useMemo(
    () => definitionToPuckData(definition, installedPageComponentRegistry),
    [],
  );
  // Live values behind stable getters: a new config object would reset Puck's
  // UI state and drop the owner's selection after every accepted edit.
  const definitionRef = useRef(definition);
  definitionRef.current = definition;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const validationRef = useRef(onValidationChange);
  validationRef.current = onValidationChange;
  const mediaRef = useRef(media);
  mediaRef.current = media;
  // The photo picker lives here, in the editor's own document, so it opens as a
  // full-screen dialog. A "Change photo" control on a canvas image asks to open
  // it and says what to do with the chosen photo.
  const [photoPickerChoose, setPhotoPickerChoose] = useState<
    ((photo: ChosenPhoto) => void) | null
  >(null);
  const openPhotoPickerRef = useRef<OpenPhotoPicker>(() => undefined);
  openPhotoPickerRef.current = (onChoose) =>
    setPhotoPickerChoose(() => onChoose);
  const config = useMemo(
    () => createVisualComponentConfig(
      () => referencedPageComponentIds(definitionRef.current),
      () => definitionRef.current,
      (source, invalid) => validationRef.current(source, invalid),
      () => disabledRef.current,
      () => mediaRef.current,
      () => openPhotoPickerRef.current,
    ),
    [],
  );
  const [message, setMessage] = useState("");
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  function accept(data: Data) {
    if (!active.current || disabled) return;
    const result = puckDataToDefinition(definition, data, installedPageComponentRegistry);
    if (!result.ok) {
      setMessage(Object.values(result.errors)[0] ?? "Composition rejected.");
      return;
    }
    if (JSON.stringify(result.definition) === JSON.stringify(definition)) return;
    setMessage("");
    onChange(result.definition);
  }

  return (
    <section className="visual-component-editor" aria-label="Page editor">
      {message !== "" ? (
        <p className="editor-message" role="status" aria-live="polite">{message}</p>
      ) : null}
      <div className="puck-editor-frame" aria-disabled={disabled} inert={disabled ? true : undefined}>
        <Puck
          config={config as Config}
          data={initialData as Data}
          iframe={{ enabled: iframeEnabled, syncHostStyles: iframeEnabled }}
          height="46rem"
          permissions={{ insert: !disabled, drag: !disabled, duplicate: !disabled, delete: !disabled, edit: !disabled }}
          onChange={(data) => accept(data as Data)}
        >
          <Puck.Layout>
            <PermissionRefresher definition={definition} />
            {/* The page is the editing surface: the live preview dominates,
              * and everything about the selected section sits beside it. */}
            <div className="editor-workbench">
              <div
                className="editor-canvas"
                aria-label="Your page — click a section to edit it"
              >
                <Puck.Preview />
              </div>
              <aside className="editor-side" aria-label="Page settings and selected section">
                <SelectedSectionActions
                  disabled={disabled}
                  protectedComponentIds={referencedPageComponentIds(definition)}
                />
                <PanelFields />
                <PanelWhenEmpty>{panelWhenEmpty}</PanelWhenEmpty>
                <AddSectionMenu disabled={disabled} />
              </aside>
            </div>
          </Puck.Layout>
        </Puck>
      </div>
      {media !== undefined ? (
        <MediaPicker
          open={photoPickerChoose !== null}
          csrfToken={media.csrfToken}
          workspaceId={media.workspaceId}
          siteImages={media.siteImages}
          confirmLabel="Use this photo"
          onChoose={(photo) => {
            photoPickerChoose?.(photo);
            setPhotoPickerChoose(null);
          }}
          onClose={() => setPhotoPickerChoose(null)}
        />
      ) : null}
    </section>
  );
}
