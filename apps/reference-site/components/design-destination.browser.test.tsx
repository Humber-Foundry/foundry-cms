import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import {
  designPresets,
  referenceSiteDefinition,
  siteDesignAttributes,
} from "@humber-foundry/site-definition";

import { ContentEditor } from "./content-editor";

function designRevision(workspaceId: string) {
  return {
    workspaceId,
    revision: 4,
    definition: referenceSiteDefinition,
    inputs: {
      contentHash: "design-content-hash",
      schemaVersion: "1.5.0",
      rendererVersion: "renderer-design",
      productionBase: "published-design",
    },
    createdAt: "2026-08-15T00:00:00.000Z",
    createdBy: "membership-design",
  } as never;
}

function mountDesign(workspaceId: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => {
    root.render(
      createElement(ContentEditor, {
        csrfToken: "csrf-design-test",
        initialRevision: designRevision(workspaceId),
        initialPreviewUrl: "/preview/design",
        activeWorkspaceUrl: "/dash/design?workspace=design",
        heading: "Design",
        fieldGroups: ["Design"],
        showComposition: false,
        showDesignDestination: true,
        showPublicationHistory: false,
      }),
    );
  });
  return { host, root };
}

/** What the live preview says the site currently looks like. */
function previewAttributes(host: HTMLElement): Record<string, string | null> {
  const canvas = host.querySelector(".design-preview .site-canvas");
  expect(canvas).not.toBeNull();
  return Object.fromEntries(
    Object.keys(siteDesignAttributes(referenceSiteDefinition.design)).map(
      (attribute) => [attribute, canvas!.getAttribute(attribute)],
    ),
  );
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

async function choose(host: HTMLElement, label: string): Promise<void> {
  const option = Array.from(
    host.querySelectorAll<HTMLLabelElement>(".design-preset, .design-option"),
  ).find(
    (candidate) =>
      candidate.querySelector(
        ".design-preset-name, .design-option-label",
      )?.textContent === label,
  );
  expect(option, `no design option labelled ${label}`).toBeDefined();
  await userEvent.click(option!.querySelector("input")!);
  await settle();
}

describe("design studio browser acceptance", () => {
  const mounted: Array<ReturnType<typeof createRoot>> = [];

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const root of mounted.splice(0)) {
      flushSync(() => root.unmount());
    }
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("shows every preset by name and says which one the site uses", async () => {
    const { host, root } = mountDesign("workspace_design_presets");
    mounted.push(root);
    await settle();

    const names = Array.from(
      host.querySelectorAll(".design-preset-name"),
    ).map((element) => element.textContent);

    expect(names).toEqual(designPresets.map(({ name }) => name));
    expect(host.querySelector(".design-section-help")?.textContent).toContain(
      "Your site uses the Editorial look",
    );
    expect(
      host.querySelectorAll(".design-preset[data-selected='true']"),
    ).toHaveLength(1);
  });

  it("changes the whole preview when a preset look is chosen", async () => {
    const { host, root } = mountDesign("workspace_design_preset_click");
    mounted.push(root);
    await settle();
    const gallery = designPresets.find(({ id }) => id === "gallery")!;

    expect(previewAttributes(host)).toEqual(
      siteDesignAttributes(referenceSiteDefinition.design),
    );

    await choose(host, gallery.name);

    expect(previewAttributes(host)).toEqual(
      siteDesignAttributes(gallery.design),
    );
    expect(host.querySelector(".design-section-help")?.textContent).toContain(
      "Your site uses the Gallery look",
    );
  });

  it("undoes a whole preset look in one step", async () => {
    const { host, root } = mountDesign("workspace_design_preset_undo");
    mounted.push(root);
    await settle();
    const gallery = designPresets.find(({ id }) => id === "gallery")!;

    await choose(host, gallery.name);
    const undo = Array.from(
      host.querySelectorAll<HTMLButtonElement>(".editor-toolbar button"),
    ).find((button) => button.textContent === "Undo");
    expect(undo?.disabled).toBe(false);
    await userEvent.click(undo!);
    await settle();

    expect(previewAttributes(host)).toEqual(
      siteDesignAttributes(referenceSiteDefinition.design),
    );
  });

  it("shows a single fine-tuned change and reports the design as no longer a preset", async () => {
    const { host, root } = mountDesign("workspace_design_fine_tune");
    mounted.push(root);
    await settle();

    await choose(host, "Clay red");

    expect(previewAttributes(host)).toEqual({
      ...siteDesignAttributes(referenceSiteDefinition.design),
      "data-colour-accent": "clay",
    });
    expect(host.querySelector(".design-section-help")?.textContent).toContain(
      "does not match any of these looks",
    );
    expect(
      host.querySelectorAll(".design-preset[data-selected='true']"),
    ).toHaveLength(0);
  });

  it("changes a section's arrangement from its own plainly named control", async () => {
    const { host, root } = mountDesign("workspace_design_section_style");
    mounted.push(root);
    await settle();

    await choose(host, "Three cards");

    expect(
      host
        .querySelector(".design-preview .services")
        ?.getAttribute("data-component-variant"),
    ).toBe("cards");
  });

  it("names every control and every option in the owner's words", async () => {
    const { host, root } = mountDesign("workspace_design_labels");
    mounted.push(root);
    await settle();

    const legends = Array.from(
      host.querySelectorAll(".design-control > legend"),
    ).map((element) => element.textContent);
    const optionLabels = Array.from(
      host.querySelectorAll(".design-option-label"),
    ).map((element) => element.textContent ?? "");

    expect(legends).toEqual([
      "Heading font",
      "Body text font",
      "Accent colour",
      "Page tone",
      "Space between sections",
      "Content width",
      "Opening section",
      "Services section",
      "Quote and numbers section",
      "Closing section",
    ]);
    expect(optionLabels.length).toBeGreaterThan(0);
    for (const label of optionLabels) {
      expect(label).toMatch(/^[A-Z]/u);
    }
    expect(host.querySelector(".design-destination select")).toBeNull();
  });
});
