"use client";

import { useMemo, useState } from "react";
import {
  Puck,
  type Config,
  type Data,
} from "@puckeditor/core";

import {
  createDefaultPageSection,
  pageCompositionContract,
  referencedPageComponentIds,
  type CallToActionSection,
  type HeroSection,
  type ProofSection,
  type ServicesSection,
  type SiteDefinition,
} from "@foundry/site-definition";

import {
  definitionToPuckData,
  puckDataToDefinition,
} from "../src/page-composition-puck";
import { SiteSection } from "./site-renderer";

type RegisteredComponents = {
  hero: HeroSection;
  services: ServicesSection;
  proof: ProofSection;
  callToAction: CallToActionSection;
};

const defaults = {
  hero: createDefaultPageSection("hero", "section_new_hero") as HeroSection,
  services: createDefaultPageSection(
    "services",
    "section_new_services",
  ) as ServicesSection,
  proof: createDefaultPageSection("proof", "section_new_proof") as ProofSection,
  callToAction: createDefaultPageSection(
    "callToAction",
    "section_new_call_to_action",
  ) as CallToActionSection,
};

function newStableComponentId(type: keyof RegisteredComponents): string {
  const typeSlug = type.replace(
    /[A-Z]/gu,
    (letter) => `_${letter.toLowerCase()}`,
  );
  return `section_${typeSlug}_${crypto.randomUUID().replaceAll("-", "")}`;
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
      defaultProps: defaults.hero,
      resolveData: (data, { trigger }) =>
        trigger === "insert"
          ? { ...data, props: { ...data.props, id: newStableComponentId("hero") } }
          : data,
      render: ({
        id,
        type,
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
        eyebrow: { type: "text", label: "Eyebrow" },
        title: { type: "text", label: "Title" },
        introduction: { type: "textarea", label: "Introduction" },
        items: { type: "custom", visible: false, render: () => <></> },
      },
      defaultProps: defaults.services,
      resolveData: (data, { trigger }) =>
        trigger === "insert"
          ? {
              ...data,
              props: {
                ...data.props,
                id: newStableComponentId("services"),
              },
            }
          : data,
      render: ({ id, type, eyebrow, title, introduction, items }) => (
        <SiteSection
          section={{ id, type, eyebrow, title, introduction, items }}
        />
      ),
    },
    proof: {
      label: pageCompositionContract.components.proof.label,
      fields: {
        id: { type: "custom", visible: false, render: () => <></> },
        type: { type: "custom", visible: false, render: () => <></> },
        quote: { type: "textarea", label: "Quote" },
        attribution: { type: "text", label: "Attribution" },
        metrics: { type: "custom", visible: false, render: () => <></> },
      },
      defaultProps: defaults.proof,
      resolveData: (data, { trigger }) =>
        trigger === "insert"
          ? { ...data, props: { ...data.props, id: newStableComponentId("proof") } }
          : data,
      render: ({ id, type, quote, attribution, metrics }) => (
        <SiteSection
          section={{ id, type, quote, attribution, metrics }}
        />
      ),
    },
    callToAction: {
      label: pageCompositionContract.components.callToAction.label,
      fields: {
        id: { type: "custom", visible: false, render: () => <></> },
        type: { type: "custom", visible: false, render: () => <></> },
        eyebrow: { type: "text", label: "Eyebrow" },
        title: { type: "text", label: "Title" },
        body: { type: "textarea", label: "Body" },
        action: { type: "custom", visible: false, render: () => <></> },
      },
      defaultProps: defaults.callToAction,
      resolveData: (data, { trigger }) =>
        trigger === "insert"
          ? {
              ...data,
              props: {
                ...data.props,
                id: newStableComponentId("callToAction"),
              },
            }
          : data,
      render: ({ id, type, eyebrow, title, body, action }) => (
        <SiteSection
          section={{ id, type, eyebrow, title, body, action }}
        />
      ),
    },
  },
};

export function createVisualComponentConfig(
  protectedComponentIds: ReadonlySet<string>,
): Config<RegisteredComponents> {
  return {
    ...visualComponentConfig,
    components: Object.fromEntries(
      Object.entries(visualComponentConfig.components).map(
        ([type, component]) => [
          type,
          {
            ...component,
            resolvePermissions: (data: { props: { id: string } }) => ({
              delete: !protectedComponentIds.has(data.props.id),
            }),
          },
        ],
      ),
    ),
  } as unknown as Config<RegisteredComponents>;
}

export function VisualComponentEditor({
  definition,
  disabled,
  onChange,
}: {
  definition: SiteDefinition;
  disabled: boolean;
  onChange(definition: SiteDefinition): void;
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
      ),
    [definition],
  );
  const [message, setMessage] = useState("");

  function accept(data: Data<RegisteredComponents>) {
    if (disabled) {
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
          iframe={{ enabled: true, syncHostStyles: true }}
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
            <Puck.Components />
            <Puck.Preview />
            <Puck.Fields />
          </Puck.Layout>
        </Puck>
      </div>
    </section>
  );
}
