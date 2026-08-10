"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createUsePuck,
  Puck,
  registerOverlayPortal,
  type Config,
  type Data,
} from "@puckeditor/core";

import {
  parseSerializedRichTextDocument,
  pageCompositionContract,
  referencedPageComponentIds,
  serializeRichTextDocument,
  siteDesignAttributes,
  type CallToActionSection,
  type HeroSection,
  type PageComponentField,
  type PageSection,
  type ProofSection,
  type ServicesSection,
  type SiteDefinition,
} from "@humber-foundry/site-definition";

import { definitionToPuckData, puckDataToDefinition } from "../src/page-composition-puck";
import { RichTextEditor } from "./rich-text-editor";
import { SiteSection } from "./site-renderer";
import {
  asRegisteredPageSection,
  createPuckField,
  installedPageComponentRegistry,
  type InstalledPageComponentRegistration,
} from "../foundry/page-components";

type RegisteredComponentProps = { id: string } & Record<string, unknown>;
type RegisteredComponents = {
  hero: HeroSection;
  services: ServicesSection;
  proof: ProofSection;
  callToAction: CallToActionSection;
  imageCopyStory: RegisteredComponentProps;
  photoBand: RegisteredComponentProps;
  connectorCards: RegisteredComponentProps;
  invitationNewsletter: RegisteredComponentProps;
};

function DesignScopedSection({
  definition,
  section,
}: {
  definition: SiteDefinition;
  section: PageSection;
}) {
  return (
    <div className="site-canvas" {...siteDesignAttributes(definition.design)}>
      <SiteSection section={section} definition={definition} />
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

function InsertComponentActions({ disabled }: { disabled: boolean }) {
  const dispatch = useVisualPuck((state) => state.dispatch);
  const contentLength = useVisualPuck((state) => state.appState.data.content.length);
  return (
    <div aria-label="Add registered page component">
      {installedPageComponentRegistry.allowedComponents.map((type) => (
        <button
          key={type}
          type="button"
          disabled={disabled}
          onClick={() =>
            dispatch({
              type: "insert",
              componentType: type,
              destinationIndex: contentLength,
              destinationZone: "root:default-zone",
              id: newStableComponentId(type),
              recordHistory: true,
            })
          }
        >
          Add {installedPageComponentRegistry.components[type]!.label}
        </button>
      ))}
    </div>
  );
}

function ComponentStructureActions({
  disabled,
  protectedComponentIds,
}: {
  disabled: boolean;
  protectedComponentIds: ReadonlySet<string>;
}) {
  const dispatch = useVisualPuck((state) => state.dispatch);
  const content = useVisualPuck((state) => state.appState.data.content);
  const zone = "root:default-zone";
  return (
    <ol aria-label="Order registered page components">
      {content.map((item, index) => {
        const registration = installedPageComponentRegistry.components[item.type];
        const label = registration?.label ?? item.type;
        const id = String(item.props.id);
        return (
          <li key={id}>
            <span>{label}</span>
            <button
              type="button"
              disabled={disabled || index === 0}
              aria-label={`Move ${label} ${index + 1} up`}
              onClick={() => dispatch({
                type: "move",
                sourceIndex: index,
                sourceZone: zone,
                destinationIndex: index - 1,
                destinationZone: zone,
                recordHistory: true,
              })}
            >↑</button>
            <button
              type="button"
              disabled={disabled || index === content.length - 1}
              aria-label={`Move ${label} ${index + 1} down`}
              onClick={() => dispatch({
                type: "move",
                sourceIndex: index,
                sourceZone: zone,
                destinationIndex: index + 1,
                destinationZone: zone,
                recordHistory: true,
              })}
            >↓</button>
            <button
              type="button"
              disabled={disabled}
              aria-label={`Duplicate ${label} ${index + 1}`}
              onClick={() => dispatch({
                type: "duplicate",
                sourceIndex: index,
                sourceZone: zone,
                recordHistory: true,
              })}
            >Duplicate</button>
            <button
              type="button"
              disabled={disabled || protectedComponentIds.has(id)}
              aria-label={`Remove ${label} ${index + 1}`}
              onClick={() => dispatch({
                type: "remove",
                index,
                zone,
                recordHistory: true,
              })}
            >Remove</button>
          </li>
        );
      })}
    </ol>
  );
}

function editorField(
  field: PageComponentField,
  onValidationChange: (source: string, invalid: boolean) => void,
): Record<string, unknown> {
  if (field.editable === false) return hiddenField;
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

export function createVisualComponentConfig(
  protectedComponentIds: ReadonlySet<string>,
  definition: SiteDefinition,
  onValidationChange: (source: string, invalid: boolean) => void = ignoreRichTextValidation,
  disabled = false,
): Config<RegisteredComponents> {
  const components = Object.fromEntries(
    installedPageComponentRegistry.allowedComponents.map((type) => {
      const registration = installedPageComponentRegistry.components[type]!;
      const id = `section_new_${type.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`)}`;
      const defaultSection = registration.createDefault(id, definition);
      const defaultProps = defaultSection.type === "registered"
        ? {
            id: defaultSection.id,
            type: defaultSection.type,
            component: defaultSection.component,
            ...defaultSection.props,
          }
        : defaultSection;
      const fields = {
        id: hiddenField,
        type: hiddenField,
        ...(defaultSection.type === "registered" ? { component: hiddenField } : {}),
        ...Object.fromEntries(
          Object.entries(registration.fields).map(([key, field]) => [
            key,
            editorField(field, onValidationChange),
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
            return section.type === "callToAction"
              ? <RenderedCallToActionSection definition={definition} section={section} disabled={disabled} onValidationChange={onValidationChange} />
              : <DesignScopedSection definition={definition} section={section} />;
          },
          resolvePermissions: (data: { props: { id: string } }) => ({
            delete: !protectedComponentIds.has(data.props.id),
          }),
        },
      ];
    }),
  );
  return {
    categories: {
      page: {
        title: "Registered page components",
        components: [...installedPageComponentRegistry.allowedComponents],
      },
    },
    components,
  } as unknown as Config<RegisteredComponents>;
}

export function VisualComponentEditor({
  definition,
  disabled,
  onChange,
  onValidationChange = ignoreRichTextValidation,
  iframeEnabled = true,
}: {
  definition: SiteDefinition;
  disabled: boolean;
  onChange(definition: SiteDefinition): void;
  onValidationChange?(source: string, invalid: boolean): void;
  iframeEnabled?: boolean;
}) {
  const initialData = useMemo(
    () => definitionToPuckData(definition, installedPageComponentRegistry),
    [],
  );
  const config = useMemo(
    () => createVisualComponentConfig(
      referencedPageComponentIds(definition),
      definition,
      onValidationChange,
      disabled,
    ),
    [definition, disabled, onValidationChange],
  );
  const [message, setMessage] = useState("");
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  function accept(data: Data<RegisteredComponents>) {
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
    <section className="visual-component-editor" aria-labelledby="visual-component-editor-heading">
      <div className="dashboard-section-heading">
        <div>
          <h3 id="visual-component-editor-heading">Visual page composition</h3>
          <p>
            Add, order, duplicate, remove, and configure registered components in{" "}
            <code>{pageCompositionContract.slot.id}</code>. Use Tab to move between controls and the canvas; focus remains visible in both.
          </p>
        </div>
      </div>
      <p className="editor-message" role="status" aria-live="polite">{message}</p>
      <div className="puck-editor-frame" aria-disabled={disabled} inert={disabled ? true : undefined}>
        <Puck
          config={config as Config}
          data={initialData as Data}
          iframe={{ enabled: iframeEnabled, syncHostStyles: iframeEnabled }}
          height="46rem"
          permissions={{ insert: !disabled, drag: !disabled, duplicate: !disabled, delete: !disabled, edit: !disabled }}
          onChange={(data) => accept(data as Data<RegisteredComponents>)}
        >
          <Puck.Layout>
            <InsertComponentActions disabled={disabled} />
            <ComponentStructureActions
              disabled={disabled}
              protectedComponentIds={referencedPageComponentIds(definition)}
            />
            <Puck.Components />
            <Puck.Preview />
            <Puck.Fields />
          </Puck.Layout>
        </Puck>
      </div>
    </section>
  );
}
