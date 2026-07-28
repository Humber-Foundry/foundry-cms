"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createUsePuck,
  Puck,
  type Config,
  type Data,
} from "@puckeditor/core";

import {
  createDefaultPageSection,
  parseSerializedRichTextDocument,
  pageCompositionContract,
  referencedPageComponentIds,
  serializeRichTextDocument,
  siteDesignAttributes,
  type CallToActionSection,
  type HeroSection,
  type PageComponentType,
  type PageSection,
  type ProofSection,
  type ServicesSection,
  type SiteDefinition,
} from "@foundry/site-definition";

import {
  definitionToPuckData,
  puckDataToDefinition,
} from "../src/page-composition-puck";
import { RichTextEditor } from "./rich-text-editor";
import { SiteSection } from "./site-renderer";

type RegisteredComponents = {
  [Type in PageComponentType]: Extract<PageSection, { type: Type }>;
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
      <SiteSection section={section} />
    </div>
  );
}

function newStableComponentId(type: PageComponentType): string {
  const typeSlug = type.replace(
    /[A-Z]/gu,
    (letter) => `_${letter.toLowerCase()}`,
  );
  return `section_${typeSlug}_${crypto.randomUUID().replaceAll("-", "")}`;
}

const useVisualPuck = createUsePuck();
const ignoreRichTextValidation = () => undefined;

function InsertComponentActions({ disabled }: { disabled: boolean }) {
  const dispatch = useVisualPuck((state) => state.dispatch);
  const contentLength = useVisualPuck(
    (state) => state.appState.data.content.length,
  );
  return (
    <div aria-label="Add registered page component">
      {pageCompositionContract.slot.allowedComponents.map((type) => (
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
          Add {pageCompositionContract.components[type].label}
        </button>
      ))}
    </div>
  );
}

export const visualComponentConfig: Config<RegisteredComponents> = {
  categories: {
    page: {
      title: "Registered page components",
      components: [...pageCompositionContract.slot.allowedComponents],
    },
  },
  components: {
    hero: {
      label: pageCompositionContract.components.hero.label,
      fields: {
        id: { type: "custom", visible: false, render: () => <></> },
        type: { type: "custom", visible: false, render: () => <></> },
        variant: { type: "custom", visible: false, render: () => <></> },
        eyebrow: { type: "text", label: "Eyebrow" },
        title: { type: "text", label: "Title" },
        summary: { type: "textarea", label: "Summary" },
        primaryAction: {
          type: "custom",
          visible: false,
          render: () => <></>,
        },
        secondaryAction: {
          type: "custom",
          visible: false,
          render: () => <></>,
        },
      },
      defaultProps: createDefaultPageSection(
        "hero",
        "section_new_hero",
      ) as HeroSection,
      render: ({
        id,
        type,
        variant,
        eyebrow,
        title,
        summary,
        primaryAction,
        secondaryAction,
      }) => (
        <SiteSection
          section={{
            id,
            type,
            variant,
            eyebrow,
            title,
            summary,
            primaryAction,
            secondaryAction,
          }}
        />
      ),
    },
    services: {
      label: pageCompositionContract.components.services.label,
      fields: {
        id: { type: "custom", visible: false, render: () => <></> },
        type: { type: "custom", visible: false, render: () => <></> },
        variant: { type: "custom", visible: false, render: () => <></> },
        eyebrow: { type: "text", label: "Eyebrow" },
        title: { type: "text", label: "Title" },
        introduction: { type: "textarea", label: "Introduction" },
        items: { type: "custom", visible: false, render: () => <></> },
      },
      defaultProps: createDefaultPageSection(
        "services",
        "section_new_services",
      ) as ServicesSection,
      render: ({
        id,
        type,
        variant,
        eyebrow,
        title,
        introduction,
        items,
      }) => (
        <SiteSection
          section={{
            id,
            type,
            variant,
            eyebrow,
            title,
            introduction,
            items,
          }}
        />
      ),
    },
    proof: {
      label: pageCompositionContract.components.proof.label,
      fields: {
        id: { type: "custom", visible: false, render: () => <></> },
        type: { type: "custom", visible: false, render: () => <></> },
        variant: { type: "custom", visible: false, render: () => <></> },
        quote: { type: "textarea", label: "Quote" },
        attribution: { type: "text", label: "Attribution" },
        metrics: { type: "custom", visible: false, render: () => <></> },
      },
      defaultProps: createDefaultPageSection(
        "proof",
        "section_new_proof",
      ) as ProofSection,
      render: ({ id, type, variant, quote, attribution, metrics }) => (
        <SiteSection
          section={{ id, type, variant, quote, attribution, metrics }}
        />
      ),
    },
    callToAction: {
      label: pageCompositionContract.components.callToAction.label,
      fields: {
        id: { type: "custom", visible: false, render: () => <></> },
        type: { type: "custom", visible: false, render: () => <></> },
        variant: { type: "custom", visible: false, render: () => <></> },
        eyebrow: { type: "text", label: "Eyebrow" },
        title: { type: "text", label: "Title" },
        body: {
          type: "custom",
          label: "Body",
          render: ({ name, onChange, value }) => (
            <RichTextEditor
              id={`${name}-editor`}
              value={serializeRichTextDocument(value)}
              disabled={false}
              invalid={false}
              describedBy={`${name}-help`}
              label="Body"
              onChange={(nextValue) =>
                onChange(parseSerializedRichTextDocument(nextValue))
              }
            />
          ),
        },
        action: { type: "custom", visible: false, render: () => <></> },
      },
      defaultProps: createDefaultPageSection(
        "callToAction",
        "section_new_call_to_action",
      ) as CallToActionSection,
      render: ({ id, type, variant, eyebrow, title, body, action }) => (
        <SiteSection
          section={{ id, type, variant, eyebrow, title, body, action }}
        />
      ),
    },
  },
};

export function createVisualComponentConfig(
  protectedComponentIds: ReadonlySet<string>,
  definition: SiteDefinition,
  onValidationChange: (
    source: string,
    invalid: boolean,
  ) => void = ignoreRichTextValidation,
): Config<RegisteredComponents> {
  return {
    ...visualComponentConfig,
    components: {
      hero: {
        ...visualComponentConfig.components.hero,
        render: (props) => (
          <DesignScopedSection
            definition={definition}
            section={props as HeroSection}
          />
        ),
        defaultProps: createDefaultPageSection(
          "hero",
          "section_new_hero",
          definition,
        ) as HeroSection,
        resolvePermissions: (data) => ({
          delete: !protectedComponentIds.has(data.props.id),
        }),
      },
      services: {
        ...visualComponentConfig.components.services,
        render: (props) => (
          <DesignScopedSection
            definition={definition}
            section={props as ServicesSection}
          />
        ),
        defaultProps: createDefaultPageSection(
          "services",
          "section_new_services",
          definition,
        ) as ServicesSection,
        resolvePermissions: (data) => ({
          delete: !protectedComponentIds.has(data.props.id),
        }),
      },
      proof: {
        ...visualComponentConfig.components.proof,
        render: (props) => (
          <DesignScopedSection
            definition={definition}
            section={props as ProofSection}
          />
        ),
        defaultProps: createDefaultPageSection(
          "proof",
          "section_new_proof",
          definition,
        ) as ProofSection,
        resolvePermissions: (data) => ({
          delete: !protectedComponentIds.has(data.props.id),
        }),
      },
      callToAction: {
        ...visualComponentConfig.components.callToAction,
        fields: {
          ...visualComponentConfig.components.callToAction.fields,
          body: {
            type: "custom",
            label: "Body",
            render: ({ name, onChange, value }) => (
              <RichTextEditor
                id={`${name}-editor`}
                value={serializeRichTextDocument(value)}
                disabled={false}
                invalid={false}
                describedBy={`${name}-help`}
                label="Body"
                onChange={(nextValue) =>
                  onChange(parseSerializedRichTextDocument(nextValue))
                }
                onValidationChange={(invalid) =>
                  onValidationChange(name, invalid)
                }
              />
            ),
          },
        } as NonNullable<
          (typeof visualComponentConfig.components.callToAction)["fields"]
        >,
        render: (props) => (
          <DesignScopedSection
            definition={definition}
            section={props as CallToActionSection}
          />
        ),
        defaultProps: createDefaultPageSection(
          "callToAction",
          "section_new_call_to_action",
          definition,
        ) as CallToActionSection,
        resolvePermissions: (data) => ({
          delete: !protectedComponentIds.has(data.props.id),
        }),
      },
    },
  };
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
    () => definitionToPuckData(definition),
    // Puck owns its editing state after mount. A saved revision remounts this
    // component through the key supplied by ContentEditor.
    [],
  );
  const config = useMemo(
    () =>
      createVisualComponentConfig(
        referencedPageComponentIds(definition),
        definition,
        onValidationChange,
      ),
    [definition, onValidationChange],
  );
  const [message, setMessage] = useState("");
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  function accept(data: Data<RegisteredComponents>) {
    if (!active.current || disabled) {
      return;
    }
    const result = puckDataToDefinition(definition, data);
    if (!result.ok) {
      setMessage(Object.values(result.errors)[0] ?? "Composition rejected.");
      return;
    }
    if (JSON.stringify(result.definition) === JSON.stringify(definition)) {
      return;
    }
    setMessage("");
    onChange(result.definition);
  }

  return (
    <section
      className="visual-component-editor"
      aria-labelledby="visual-component-editor-heading"
    >
      <div className="dashboard-section-heading">
        <div>
          <h3 id="visual-component-editor-heading">Visual page composition</h3>
          <p>
            Add, order, duplicate, remove, and configure registered components
            in <code>{pageCompositionContract.slot.id}</code>. Use Tab to move
            between controls and the canvas; focus remains visible in both.
          </p>
        </div>
      </div>
      <p className="editor-message" role="status" aria-live="polite">
        {message}
      </p>
      <div
        className="puck-editor-frame"
        aria-disabled={disabled}
        inert={disabled ? true : undefined}
      >
        <Puck
          config={config as Config}
          data={initialData as Data}
          iframe={{
            enabled: iframeEnabled,
            syncHostStyles: iframeEnabled,
          }}
          height="46rem"
          permissions={{
            insert: !disabled,
            drag: !disabled,
            duplicate: !disabled,
            delete: !disabled,
            edit: !disabled,
          }}
          onChange={(data) => accept(data as Data<RegisteredComponents>)}
        >
          <Puck.Layout>
            <InsertComponentActions disabled={disabled} />
            <Puck.Components />
            <Puck.Preview />
            <Puck.Fields />
          </Puck.Layout>
        </Puck>
      </div>
    </section>
  );
}
