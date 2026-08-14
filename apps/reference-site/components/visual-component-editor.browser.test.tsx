import { createElement, StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import {
  createDefaultPageSection,
  referenceSiteDefinition,
  serializeRichTextDocument,
  toPageComposition,
  type SiteDefinition,
} from "@humber-foundry/site-definition";

import {
  createVisualComponentConfig,
  VisualComponentEditor,
} from "./visual-component-editor";
import { ContentEditor } from "./content-editor";
import { RichTextEditor } from "./rich-text-editor";
import {
  clearStaleEdits,
  preserveStaleEdits,
} from "../src/content-editor-recovery";
import {
  clearContentEditorOutbox,
  readContentEditorOutbox,
  writeContentEditorOutbox,
} from "../src/content-editor-outbox";
import { installedSiteDefinition } from "../foundry/site-definition";
function browserRevision(workspaceId: string) {
  return {
    workspaceId,
    revision: 4,
    definition: referenceSiteDefinition,
    inputs: {
      contentHash: "browser-content-hash",
      schemaVersion: "1.2.0",
      rendererVersion: "renderer-browser",
      productionBase: "published-browser",
    },
    createdAt: "2026-07-27T00:00:00.000Z",
    createdBy: "membership-browser",
  } as never;
}

async function waitForEditorValue(
  host: HTMLElement,
  expected: string,
): Promise<boolean> {
  for (let index = 0; index < 50; index += 1) {
    if (
      Array.from(
        host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
          ".editor-groups input, .editor-groups textarea, .editor-side-fields input, .editor-side-fields textarea",
        ),
      ).some(({ value }) => value === expected)
    ) {
      return true;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 20));
  }
  return false;
}

async function enterEditMode(host: HTMLElement): Promise<void> {
  const editButton = Array.from(
    host.querySelectorAll<HTMLButtonElement>(".mode-toggle button"),
  ).find((button) => button.textContent === "Edit");
  expect(editButton).toBeDefined();
  await userEvent.click(editButton!);
  for (
    let index = 0;
    index < 100 && host.querySelector(".visual-component-editor") === null;
    index += 1
  ) {
    await new Promise((resolve) => window.setTimeout(resolve, 20));
  }
  expect(host.querySelector(".visual-component-editor")).not.toBeNull();
}

async function editorCanvasDocument(host: HTMLElement): Promise<Document> {
  for (let index = 0; index < 100; index += 1) {
    const document = host.querySelector("iframe")?.contentDocument;
    if (document?.querySelector(".site-canvas") != null) {
      return document;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 20));
  }
  throw new Error("editor_canvas_not_ready");
}

async function selectEditorSection(
  host: HTMLElement,
  sectionId: string,
): Promise<Document> {
  let document = await editorCanvasDocument(host);
  let section: HTMLElement | null = null;
  for (let index = 0; index < 100 && section === null; index += 1) {
    document = await editorCanvasDocument(host);
    section = document.getElementById(sectionId);
    if (section === null) {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    }
  }
  expect(section).not.toBeNull();
  await userEvent.click(
    section!.querySelector<HTMLElement>("h1, h2") ?? section!,
  );
  for (
    let index = 0;
    index < 100 && host.querySelector(".section-actions") === null;
    index += 1
  ) {
    await new Promise((resolve) => window.setTimeout(resolve, 20));
  }
  expect(host.querySelector(".section-actions")).not.toBeNull();
  return document;
}

async function openPublishingHistory(host: HTMLElement): Promise<void> {
  const summary = host.querySelector<HTMLElement>(
    ".publication-history-panel > summary",
  );
  expect(summary).not.toBeNull();
  await userEvent.click(summary!);
  expect(
    host.querySelector<HTMLDetailsElement>(".publication-history-panel")?.open,
  ).toBe(true);
}

describe("visual component editor browser acceptance", () => {
  const mounted: Array<ReturnType<typeof createRoot>> = [];

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const root of mounted.splice(0)) {
      flushSync(() => root.unmount());
    }
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("keeps Shift+Enter inside the supported rich-text schema without crashing", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);
    const callToAction = referenceSiteDefinition.home.sections.find(
      (section) => section.type === "callToAction",
    )!;
    if (callToAction.type !== "callToAction") {
      throw new Error("expected_call_to_action_fixture");
    }
    const editorProps = {
      id: "rich-editor-regression",
      value: serializeRichTextDocument(callToAction.body),
      disabled: false,
      describedBy: "rich-editor-help",
      labelledBy: "rich-editor-label",
      onChange: () => undefined,
    };

    flushSync(() => {
      root.render(
        createElement(RichTextEditor, {
          ...editorProps,
          invalid: false,
        }),
      );
    });
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const editable = host.querySelector<HTMLElement>(
      '[contenteditable="true"]',
    );
    expect(editable).not.toBeNull();
    expect(editable!.getAttribute("id")).toBe("rich-editor-regression");
    expect(editable!.getAttribute("aria-label")).toBeNull();
    expect(editable!.getAttribute("aria-labelledby")).toBe("rich-editor-label");
    expect(editable!.getAttribute("aria-describedby")).toBe("rich-editor-help");
    expect(editable!.getAttribute("aria-invalid")).toBe("false");
    expect(
      host.querySelector(".rich-text-editor")?.getAttribute("aria-label"),
    ).toBeNull();
    expect(
      host.querySelector(".rich-text-toolbar")?.getAttribute(
        "aria-labelledby",
      ),
    ).toBe("rich-editor-label");

    flushSync(() => {
      root.render(
        createElement(RichTextEditor, {
          ...editorProps,
          invalid: true,
        }),
      );
    });
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const invalidEditable = host.querySelector<HTMLElement>(
      '[contenteditable="true"]',
    );
    expect(invalidEditable?.getAttribute("aria-invalid")).toBe("true");

    invalidEditable!.focus();
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");

    expect(host.querySelector("#rich-editor-regression")).not.toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("reports local rich-text validation and clears it after a valid edit", async () => {
    vi.stubGlobal(
      "prompt",
      vi.fn().mockReturnValue("javascript:alert(1)"),
    );
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);
    const callToAction = referenceSiteDefinition.home.sections.find(
      (section) => section.type === "callToAction",
    )!;
    if (callToAction.type !== "callToAction") {
      throw new Error("expected_call_to_action_fixture");
    }
    const onValidationChange = vi.fn();

    flushSync(() => {
      root.render(
        createElement(RichTextEditor, {
          id: "rich-editor-local-validation",
          value: serializeRichTextDocument(callToAction.body),
          disabled: false,
          describedBy: "rich-editor-local-help",
          labelledBy: "rich-editor-local-label",
          invalid: false,
          onChange: () => undefined,
          onValidationChange,
        }),
      );
    });
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const linkButton = Array.from(
      host.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Link");
    expect(linkButton).toBeDefined();
    await userEvent.click(linkButton!);

    expect(onValidationChange).toHaveBeenLastCalledWith(true);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    const editable = host.querySelector<HTMLElement>(
      '[contenteditable="true"]',
    )!;
    expect(editable.getAttribute("aria-invalid")).toBe("true");

    editable.focus();
    await userEvent.keyboard("{End}x");
    for (
      let index = 0;
      index < 20 && host.querySelector('[role="alert"]') !== null;
      index += 1
    ) {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    }

    expect(onValidationChange).toHaveBeenLastCalledWith(false);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(editable.getAttribute("aria-invalid")).toBe("false");
  });

  it("synchronizes a recovered rich-text value into the rendered editor", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);
    const callToAction = referenceSiteDefinition.home.sections.find(
      (section) => section.type === "callToAction",
    )!;
    if (callToAction.type !== "callToAction") {
      throw new Error("expected_call_to_action_fixture");
    }
    const props = {
      id: "rich-editor-external-value",
      disabled: false,
      describedBy: "rich-editor-external-help",
      labelledBy: "rich-editor-external-label",
      invalid: false,
      onChange: () => undefined,
    };

    flushSync(() => {
      root.render(
        createElement(RichTextEditor, {
          ...props,
          value: serializeRichTextDocument(callToAction.body),
        }),
      );
    });
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    flushSync(() => {
      root.render(
        createElement(RichTextEditor, {
          ...props,
          value: serializeRichTextDocument({
            ...callToAction.body,
            children: [
              {
                type: "paragraph",
                children: [
                  {
                    type: "text",
                    text: "Recovered external value.",
                    marks: [],
                  },
                ],
              },
            ],
          }),
        }),
      );
    });
    for (
      let index = 0;
      index < 20 && !host.textContent?.includes("Recovered external value.");
      index += 1
    ) {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    }

    expect(host.textContent).toContain("Recovered external value.");
  });

  it("renders the registered editor in a same-origin iframe with keyboard-visible controls", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);

    flushSync(() => {
      root.render(
        createElement(VisualComponentEditor, {
          definition: referenceSiteDefinition,
          disabled: false,
          onChange: () => undefined,
        }),
      );
    });
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

    expect(
      host.querySelector(".visual-component-editor")?.getAttribute("aria-label"),
    ).toBe("Page editor");
    expect(
      host.querySelector(".add-section-menu summary")?.textContent,
    ).toContain("Add section");
    const iframe = host.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("src")).toBeNull();
    expect(iframe?.contentDocument).not.toBeNull();
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    const designScope =
      host.querySelector(".site-canvas") ??
      iframe?.contentDocument?.querySelector(".site-canvas");
    expect(designScope?.getAttribute("data-colour-accent")).toBe("moss");

    (document.activeElement as HTMLElement | null)?.blur();
    // The one add-section menu is a keyboard-openable disclosure.
    const addMenu = host.querySelector<HTMLDetailsElement>(".add-section-menu");
    const addSummary = addMenu?.querySelector("summary") ?? null;
    expect(addSummary).not.toBeNull();
    expect(addMenu!.open).toBe(false);
    addSummary!.focus();
    await userEvent.keyboard("{Enter}");
    expect(addMenu!.open).toBe(true);

    for (
      let index = 0;
      index < 30 && document.activeElement !== iframe;
      index += 1
    ) {
      await userEvent.tab();
    }
    expect(document.activeElement).toBe(iframe);
    const firstIframeControl = iframe!.contentDocument!.activeElement;
    expect(firstIframeControl).not.toBe(iframe!.contentDocument!.body);
    await userEvent.tab();
    expect(iframe!.contentDocument!.activeElement).not.toBe(firstIframeControl);
    expect(iframe!.contentDocument!.activeElement).not.toBe(
      iframe!.contentDocument!.body,
    );
  });

  it("edits rich text at the caret directly on the rendered page", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);
    let latest = referenceSiteDefinition;

    flushSync(() => {
      root.render(
        createElement(VisualComponentEditor, {
          definition: referenceSiteDefinition,
          disabled: false,
          iframeEnabled: false,
          onChange: (definition) => {
            latest = definition;
          },
        }),
      );
    });
    let editable: HTMLElement | null = null;
    for (let index = 0; index < 30 && editable === null; index += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
      editable = host.querySelector<HTMLElement>(
        ".site-canvas .contact [contenteditable=true]",
      );
    }

    expect(editable).not.toBeNull();
    expect(
      host.querySelector(".site-canvas .contact .rich-text-toolbar"),
    ).not.toBeNull();
    editable!.focus();
    await userEvent.keyboard("{End} Caret edit.");
    for (
      let index = 0;
      index < 30 &&
      !latest.home.sections.some(
        (section) =>
          section.type === "callToAction" &&
          JSON.stringify(section.body).includes("Caret edit."),
      );
      index += 1
    ) {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    }

    expect(
      latest.home.sections.find(
        (section) => section.type === "callToAction",
      ),
    ).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          children: expect.arrayContaining([
            expect.objectContaining({
              children: expect.arrayContaining([
                expect.objectContaining({
                  text: expect.stringContaining("Caret edit."),
                }),
              ]),
            }),
          ]),
        }),
      }),
    );
  });

  it("keeps protected props out of the editable field controls", () => {
    const config = createVisualComponentConfig(
      () => new Set(["section_contact"]),
      () => referenceSiteDefinition,
    );
    expect(Object.keys(config.components.hero.fields!)).toEqual([
      "id",
      "type",
      "variant",
      "eyebrow",
      "title",
      "summary",
      "primaryAction",
      "secondaryAction",
    ]);
    expect(
      config.components.hero.fields!.primaryAction,
    ).toEqual(expect.objectContaining({ visible: false }));
    expect(
      config.components.hero.fields!.variant,
    ).toEqual(expect.objectContaining({ visible: false }));
    expect(config.components.services.fields!.items).toEqual(
      expect.objectContaining({ visible: false }),
    );
    expect(
      config.components.callToAction.resolvePermissions!(
        { props: { id: "section_contact" } } as never,
        {} as never,
      ),
    ).toEqual({ delete: false });
    expect(
      config.components.hero.resolvePermissions!(
        { props: { id: "section_hero" } } as never,
        {} as never,
      ),
    ).toEqual({ delete: true });
  });

  it("inserts a registered component through Puck without changing its generated identity", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);
    let latest: SiteDefinition = referenceSiteDefinition;
    flushSync(() => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(VisualComponentEditor, {
            definition: referenceSiteDefinition,
            disabled: false,
            iframeEnabled: false,
            onChange: (definition) => {
              latest = definition;
            },
          }),
        ),
      );
    });
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

    // The single add-section menu opens, then offers one button per
    // installed component. Insert a Proof section from it.
    const addMenu = host.querySelector<HTMLElement>(".add-section-menu summary");
    expect(addMenu).not.toBeNull();
    addMenu!.click();
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    const proofButton = Array.from(
      host.querySelectorAll<HTMLButtonElement>(".add-section-menu button"),
    ).find((button) => button.textContent === "Proof");
    expect(proofButton).toBeDefined();
    proofButton!.click();
    await new Promise((resolve) => window.setTimeout(resolve, 100));

    expect(latest.home.sections).toHaveLength(
      referenceSiteDefinition.home.sections.length + 1,
    );
    expect(
      latest.home.sections.some(
        (section) =>
          section.type === "proof" &&
          !referenceSiteDefinition.home.sections.some(
            ({ id }) => id === section.id,
          ) &&
          /^section_proof_[a-z0-9_]+$/u.test(section.id),
      ),
    ).toBe(true);
  });

  it("adds, edits, reorders, duplicates, and removes an installation-owned component through Puck", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);
    let latest = installedSiteDefinition;
    flushSync(() => {
      root.render(
        createElement(VisualComponentEditor, {
          definition: installedSiteDefinition,
          disabled: false,
          iframeEnabled: false,
          onChange: (definition) => {
            latest = definition;
          },
        }),
      );
    });
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

    // Add an Image and copy story from the single add-section menu.
    host.querySelector<HTMLElement>(".add-section-menu summary")!.click();
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    const addStory = Array.from(
      host.querySelectorAll<HTMLButtonElement>(".add-section-menu button"),
    ).find((button) => button.textContent === "Image and copy story");
    expect(addStory).toBeDefined();
    addStory!.click();
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    const added = latest.home.sections.find(
      (section) =>
        section.type === "registered" &&
        section.component === "imageCopyStory" &&
        !installedSiteDefinition.home.sections.some(({ id }) => id === section.id),
    );
    expect(added?.id).toMatch(/^section_image_copy_story_[a-z0-9_]+$/u);

    // Select the new section and edit its Title from the side panel.
    await page.getByRole("heading", {
      name: "Make room for a better question",
    }).click();
    const title = page.getByTitle("Title");
    await expect.element(title).toBeVisible();
    await title.fill("A visible custom component edit");
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    expect(host.textContent).toContain("A visible custom component edit");
    expect(
      latest.home.sections.some(
        (section) =>
          section.type === "registered" &&
          section.props.title === "A visible custom component edit",
      ),
    ).toBe(true);

    // Duplicate the selected section from its action bar.
    await page.getByRole("button", { name: "Duplicate section" }).click();
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    expect(
      latest.home.sections.filter(
        (section) =>
          section.type === "registered" &&
          section.component === "imageCopyStory",
      ),
    ).toHaveLength(2);

    // Reordering the selected section changes the page order.
    const beforeOrder = latest.home.sections.map(({ id }) => id).join(",");
    await page.getByRole("button", { name: "Move section down" }).click();
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    expect(latest.home.sections.map(({ id }) => id).join(",")).not.toBe(
      beforeOrder,
    );

    // Remove the selected section, leaving one copy.
    await page.getByRole("button", { name: "Remove section" }).click();
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    expect(
      latest.home.sections.filter(
        (section) =>
          section.type === "registered" &&
          section.component === "imageCopyStory",
      ),
    ).toHaveLength(1);
  });

  it("round-trips unsaved structural edits through the browser outbox", async () => {
    const workspaceId = "workspace_browser_acceptance";
    await clearContentEditorOutbox(workspaceId);
    await writeContentEditorOutbox({
      workspaceId,
      baseRevision: 12,
      edits: [
        {
          path: "slot_home_sections",
          baseValue: '{"slotId":"slot_home_sections","components":[]}',
          value:
            '{"slotId":"slot_home_sections","components":[{"id":"section_hero","type":"hero"}]}',
        },
      ],
      attempt: {
        body: '{"workspaceId":"workspace_browser_acceptance"}',
        idempotencyKey: "browser-outbox-attempt-0001",
      },
    });

    expect(await readContentEditorOutbox(workspaceId)).toEqual({
      workspaceId,
      baseRevision: 12,
      edits: [
        {
          path: "slot_home_sections",
          baseValue: '{"slotId":"slot_home_sections","components":[]}',
          value:
            '{"slotId":"slot_home_sections","components":[{"id":"section_hero","type":"hero"}]}',
        },
      ],
      attempt: {
        body: '{"workspaceId":"workspace_browser_acceptance"}',
        idempotencyKey: "browser-outbox-attempt-0001",
      },
    });
    await clearContentEditorOutbox(workspaceId);
    expect(await readContentEditorOutbox(workspaceId)).toBeNull();
  });

  it("records an accepted edit before the autosave debounce", async () => {
    const workspaceId = "workspace_browser_snapshot";
    await clearContentEditorOutbox(workspaceId);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);
    flushSync(() => {
      root.render(
        createElement(ContentEditor, {
          csrfToken: "csrf-browser-test",
          initialRevision: browserRevision(workspaceId),
          initialPreviewUrl: "/preview/browser",
          activeWorkspaceUrl: "/dash?workspace=browser",
        }),
      );
    });
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    await enterEditMode(host);
    const siteName = Array.from(host.querySelectorAll("input")).find(
      (input) => input.value === referenceSiteDefinition.site.name,
    );
    expect(siteName).toBeDefined();
    await userEvent.fill(siteName!, "Recovered immediately");

    let record = await readContentEditorOutbox(workspaceId);
    for (let index = 0; record === null && index < 5; index += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
      record = await readContentEditorOutbox(workspaceId);
    }
    expect(record).toEqual({
      workspaceId,
      baseRevision: 4,
      edits: [
        {
          path: "site_foundry_reference.name",
          format: "plainText",
          baseValue: "Foundry Reference",
          value: "Recovered immediately",
        },
      ],
    });
    await clearContentEditorOutbox(workspaceId);
  });

  it("blocks save, preview, and autosave while a rich-text editor is locally invalid", async () => {
    const workspaceId = "workspace_browser_invalid_rich_text";
    await clearContentEditorOutbox(workspaceId);
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          url.includes("/api/foundry-cms/publications?") &&
          init?.method === undefined
        ) {
          return new Response(JSON.stringify({ publication: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        const body =
          typeof init?.body === "string"
            ? JSON.parse(init.body) as Record<string, unknown>
            : {};
        if (
          url.endsWith("/api/foundry-cms/revisions") &&
          body.operation === "open_preview"
        ) {
          return new Response(
            JSON.stringify({ previewUrl: "/preview/exact-revision" }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (
          url.endsWith("/api/foundry-cms/publications") &&
          body.operation === "approve"
        ) {
          return new Response(
            JSON.stringify({
              approval: { id: `approval_${"a".repeat(32)}` },
            }),
            {
              status: 201,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Promise<Response>(() => undefined);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "open",
      vi.fn().mockReturnValue({
        opener: null,
        location: { href: "" },
        close: vi.fn(),
      }),
    );
    vi.stubGlobal(
      "prompt",
      vi.fn().mockReturnValue("javascript:alert(1)"),
    );
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);
    flushSync(() => {
      root.render(
        createElement(ContentEditor, {
          csrfToken: "csrf-browser-test",
          initialRevision: browserRevision(workspaceId),
          initialPreviewUrl: "/preview/browser",
          activeWorkspaceUrl: "/dash?workspace=browser",
        }),
      );
    });
    const previewButton = Array.from(
      host.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Preview ↗");
    expect(previewButton).toBeDefined();
    await userEvent.click(previewButton!);
    for (
      let index = 0;
      index < 20 && !host.textContent?.includes("Previewed. Ready to publish.");
      index += 1
    ) {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    }
    expect(host.textContent).toContain("Previewed. Ready to publish.");
    const publishSummary = host.querySelector<HTMLElement>(
      ".publish-menu > summary",
    );
    expect(publishSummary).not.toBeNull();
    await userEvent.click(publishSummary!);
    const publishButton = Array.from(
      host.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Publish now");
    expect(publishButton).toBeDefined();
    for (
      let index = 0;
      index < 20 && publishButton!.disabled;
      index += 1
    ) {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    }
    expect(publishButton!.disabled).toBe(false);

    await enterEditMode(host);
    const canvasDocument = await selectEditorSection(host, "section_contact");
    const richTextEditor = canvasDocument
      .querySelector("#section_contact-rendered-body-editor")
      ?.closest(".rich-text-editor");
    const linkButton = Array.from(
      richTextEditor?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find((button) => button.textContent === "Link");
    expect(linkButton).toBeDefined();
    await userEvent.click(linkButton!);

    const callToActionTitle = host.querySelector<HTMLInputElement>(
      '.editor-side-fields input[title="Title"]',
    );
    expect(callToActionTitle).not.toBeNull();
    await userEvent.fill(
      callToActionTitle!,
      "Unsaved while rich text is invalid",
    );

    const saveButton = Array.from(
      host.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Save");
    const blockedPreviewButton = Array.from(
      host.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Preview last save ↗");
    expect(saveButton?.disabled).toBe(true);
    expect(blockedPreviewButton?.disabled).toBe(true);
    expect(publishButton!.disabled).toBe(true);
    await new Promise((resolve) => window.setTimeout(resolve, 350));
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).includes("/api/foundry-cms/revisions") &&
          init?.method === "POST" &&
          typeof init.body === "string" &&
          !("operation" in (JSON.parse(init.body) as object)),
      ),
    ).toBe(false);

    const editable = canvasDocument.querySelector<HTMLElement>(
      "#section_contact-rendered-body-editor",
    )!;
    editable.focus();
    await userEvent.keyboard("{End}x");
    for (
      let index = 0;
      index < 20 && saveButton?.disabled !== false;
      index += 1
    ) {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    }
    expect(saveButton?.disabled).toBe(false);
    expect(editable.getAttribute("aria-invalid")).toBe("false");
    await clearContentEditorOutbox(workspaceId);
  });

  it("shows verified publication evidence with a restore-as-draft action", async () => {
    const publicationId = `publish_${"2".repeat(32)}`;
    const restoreKeys: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST") {
        restoreKeys.push(
          new Headers(init.headers).get("idempotency-key") ?? "",
        );
        if (restoreKeys.length > 2 && restoreKeys.length <= 4) {
          throw new Error("transport_response_lost");
        }
        if (restoreKeys.length > 4) {
          return Response.json({ draft: {} });
        }
        return Response.json(
          { error: "restore_source_not_live" },
          { status: 422 },
        );
      }
      return Response.json(
        url.includes("view=history")
          ? {
              history: [
                {
                  publication: {
                    id: publicationId,
                    workspaceId: "workspace_history",
                    revision: 7,
                    approvalId: `approval_${"1".repeat(32)}`,
                    fingerprint: "f".repeat(64),
                    idempotencyKey: "browser-history-publication-1",
                    requestedBy: "membership-editor",
                    contributors: ["membership-editor"],
                    expectedHead: "b".repeat(40),
                    status: "verified-live",
                    detail: null,
                    commitSha: "c".repeat(40),
                    deploymentId: "build-browser-history",
                    deploymentRequestedAt:
                      "2026-07-27T10:00:30.000Z",
                    leaseToken: null,
                    leaseExpiresAt: null,
                    requestedAt: "2026-07-27T10:00:00.000Z",
                    updatedAt: "2026-07-27T10:02:00.000Z",
                  },
                  approval: {
                    id: `approval_${"1".repeat(32)}`,
                    workspaceId: "workspace_history",
                    revision: 7,
                    fingerprint: {
                      value: "f".repeat(64),
                      channel: "site",
                      channelConfigurationHash: "channel-browser",
                      contentHash: "d".repeat(64),
                      designHash: "a".repeat(64),
                      schemaVersion: "1.0.0",
                      rendererVersion: "renderer-browser",
                      productionBase: `git:${"b".repeat(40)}@content:${"9".repeat(64)}`,
                      artifactHash: "e".repeat(64),
                      serializationVersion:
                        "foundry.site-definition.canonical-json.v1",
                    },
                    approvedBy: "membership-editor",
                    approvedAt: "2026-07-27T09:59:00.000Z",
                    invalidatedAt: null,
                  },
                  events: [
                    {
                      status: "committed",
                      detail: null,
                      commitSha: "c".repeat(40),
                      deploymentId: null,
                      approvalFingerprint: "f".repeat(64),
                      occurredAt: "2026-07-27T10:01:00.000Z",
                    },
                    {
                      status: "verified-live",
                      detail: null,
                      commitSha: "c".repeat(40),
                      deploymentId: "build-browser-history",
                      approvalFingerprint: "f".repeat(64),
                      occurredAt: "2026-07-27T10:02:00.000Z",
                    },
                  ],
                },
              ],
            }
          : { publication: null },
      );
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);
    flushSync(() => {
      root.render(
        createElement(ContentEditor, {
          csrfToken: "csrf-history",
          initialRevision: browserRevision("workspace_history"),
          initialPreviewUrl: "/preview/history",
          activeWorkspaceUrl: "/dash?workspace=history",
        }),
      );
    });

    await enterEditMode(host);
    await openPublishingHistory(host);

    for (
      let index = 0;
      index < 20 && !host.textContent?.includes("Revision 7");
      index += 1
    ) {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    }

    expect(host.textContent).toContain("Published history");
    expect(host.textContent).toContain("Revision 7");
    expect(host.textContent).toContain("Live — your site is up to date");
    expect(
      page.getByRole("button", { name: "Restore as new draft" }),
    ).toBeDefined();
    const restoreButton = page.getByRole("button", {
      name: "Restore as new draft",
    });
    await userEvent.click(restoreButton);
    for (
      let index = 0;
      index < 20 && restoreKeys.length < 1;
      index += 1
    ) {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    }
    await userEvent.click(restoreButton);
    for (
      let index = 0;
      index < 20 && restoreKeys.length < 2;
      index += 1
    ) {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    }
    expect(restoreKeys).toHaveLength(2);
    expect(restoreKeys[1]).not.toBe(restoreKeys[0]);
    await userEvent.click(restoreButton);
    for (
      let index = 0;
      index < 20 && restoreKeys.length < 3;
      index += 1
    ) {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    }
    await userEvent.click(restoreButton);
    for (
      let index = 0;
      index < 20 && restoreKeys.length < 4;
      index += 1
    ) {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    }
    expect(restoreKeys[3]).toBe(restoreKeys[2]);
    await userEvent.click(restoreButton);
    for (
      let index = 0;
      index < 20 && restoreKeys.length < 5;
      index += 1
    ) {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    }
    await userEvent.click(restoreButton);
    for (
      let index = 0;
      index < 20 && restoreKeys.length < 6;
      index += 1
    ) {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    }
    expect(restoreKeys[5]).toBe(restoreKeys[4]);
  });

  it("distinguishes unavailable publication history from an empty history", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).includes("view=history")
        ? Response.json({ error: "request_check_unavailable" }, { status: 503 })
        : Response.json({ publication: null }),
    );
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);
    flushSync(() => {
      root.render(
        createElement(ContentEditor, {
          csrfToken: "csrf-history-unavailable",
          initialRevision: browserRevision("workspace_history_unavailable"),
          initialPreviewUrl: "/preview/history-unavailable",
          activeWorkspaceUrl: "/dash?workspace=history-unavailable",
        }),
      );
    });

    await enterEditMode(host);
    await openPublishingHistory(host);

    for (
      let index = 0;
      index < 20 &&
      !host.textContent?.includes(
        "Publication history is temporarily unavailable",
      );
      index += 1
    ) {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    }

    expect(host.textContent).toContain(
      "Publication history is temporarily unavailable",
    );
    expect(host.textContent).not.toContain(
      "No publication attempts are recorded yet.",
    );
  });

  it("restores a component before applying its dependent unsaved fields", async () => {
    const workspaceId = "workspace_browser_structural_recovery";
    await clearContentEditorOutbox(workspaceId);
    const addedProof = createDefaultPageSection(
      "proof",
      "section_recovered_proof",
      referenceSiteDefinition,
    );
    await writeContentEditorOutbox({
      workspaceId,
      baseRevision: 4,
      edits: [
        {
          path: "section_recovered_proof.quote",
          baseValue: addedProof.type === "proof" ? addedProof.quote : "",
          value: "Unsaved evidence after the durable addition",
        },
        {
          path: "slot_home_sections",
          baseValue: JSON.stringify(toPageComposition(referenceSiteDefinition)),
          value: JSON.stringify({
            ...toPageComposition(referenceSiteDefinition),
            components: [
              ...referenceSiteDefinition.home.sections,
              addedProof,
            ],
          }),
        },
      ],
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);
    flushSync(() => {
      root.render(
        createElement(ContentEditor, {
          csrfToken: "csrf-structural-recovery",
          initialRevision: browserRevision(workspaceId),
          initialPreviewUrl: "/preview/structural-recovery",
          activeWorkspaceUrl: "/dash?workspace=structural-recovery",
        }),
      );
    });

    await enterEditMode(host);
    await selectEditorSection(host, addedProof.id);
    expect(
      await waitForEditorValue(
        host,
        "Unsaved evidence after the durable addition",
      ),
    ).toBe(true);
    expect(host.textContent).not.toContain("some overlap newer values");
    await clearContentEditorOutbox(workspaceId);
  });

  it("restores a migrated component before applying its dependent stale-workspace fields", async () => {
    const destinationWorkspaceId = "workspace_browser_migrated_recovery";
    const sourceWorkspaceId = "workspace_browser_legacy_recovery";
    const recoveryId = "recovery_browser_structural_dependency";
    const addedProof = createDefaultPageSection(
      "proof",
      "section_migrated_proof",
      referenceSiteDefinition,
    );
    await clearContentEditorOutbox(destinationWorkspaceId);
    await writeContentEditorOutbox({
      workspaceId: destinationWorkspaceId,
      baseRevision: 4,
      edits: [
        {
          path: "site_foundry_reference.name",
          baseValue: referenceSiteDefinition.site.name,
          value: "Destination copy survives stale recovery",
        },
      ],
    });
    expect(
      preserveStaleEdits(
        window.localStorage,
        recoveryId,
        sourceWorkspaceId,
        [
          {
            path: "section_migrated_proof.quote",
            baseValue: addedProof.type === "proof" ? addedProof.quote : "",
            value: "Unsaved evidence carried into the upgraded workspace",
          },
          {
            path: "slot_home_sections",
            baseValue: JSON.stringify(
              toPageComposition(referenceSiteDefinition),
            ),
            value: JSON.stringify({
              ...toPageComposition(referenceSiteDefinition),
              components: [
                ...referenceSiteDefinition.home.sections,
                addedProof,
              ],
            }),
          },
          {
            path: "section_contact.body",
            baseValue:
              "Bring the rough notes, the constraints, and the thing that still feels unresolved. That is enough to start.",
            value: "Recovered legacy CTA copy alongside a structural edit.",
          },
        ],
      ),
    ).toBe(true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);
    flushSync(() => {
      root.render(
        createElement(ContentEditor, {
          csrfToken: "csrf-migrated-structural-recovery",
          initialRevision: browserRevision(destinationWorkspaceId),
          initialPreviewUrl: "/preview/migrated-structural-recovery",
          activeWorkspaceUrl: "/dash?workspace=migrated-structural-recovery",
          staleRecovery: { id: recoveryId, sourceWorkspaceId },
        }),
      );
    });

    await enterEditMode(host);
    expect(
      await waitForEditorValue(
        host,
        "Destination copy survives stale recovery",
      ),
    ).toBe(true);
    const migratedCanvas = await selectEditorSection(host, addedProof.id);
    expect(
      await waitForEditorValue(
        host,
        "Unsaved evidence carried into the upgraded workspace",
      ),
    ).toBe(true);
    await userEvent.click(
      migratedCanvas.getElementById("section_contact")!.querySelector("h2")!,
    );
    const recoveredRichText = migratedCanvas.querySelector<HTMLElement>(
      '[id="section_contact-rendered-body-editor"]',
    );
    for (
      let index = 0;
      index < 50 &&
      !recoveredRichText?.textContent?.includes(
        "Recovered legacy CTA copy alongside a structural edit.",
      );
      index += 1
    ) {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    }
    expect(recoveredRichText?.textContent).toContain(
      "Recovered legacy CTA copy alongside a structural edit.",
    );
    expect(host.textContent).not.toContain(
      "Some unsaved edits overlap newer values",
    );
    expect(
      clearStaleEdits(
        window.localStorage,
        recoveryId,
        sourceWorkspaceId,
      ),
    ).toBe(true);
    await clearContentEditorOutbox(destinationWorkspaceId);
  });

  it("keeps duplicate workspace tabs editable while coordinating browser persistence", async () => {
    const workspaceId = "workspace_browser_lock";
    await clearContentEditorOutbox(workspaceId);

    const ownerHost = document.createElement("div");
    const duplicateHost = document.createElement("div");
    document.body.append(ownerHost, duplicateHost);
    const ownerRoot = createRoot(ownerHost);
    const duplicateRoot = createRoot(duplicateHost);
    mounted.push(ownerRoot, duplicateRoot);
    flushSync(() => {
      ownerRoot.render(
        createElement(
          StrictMode,
          null,
          createElement(ContentEditor, {
            csrfToken: "csrf-owner",
            initialRevision: browserRevision(workspaceId),
            initialPreviewUrl: "/preview/owner",
            activeWorkspaceUrl: "/dash?workspace=owner",
          }),
        ),
      );
    });
    await enterEditMode(ownerHost);
    let ownerReady = false;
    for (let index = 0; index < 10 && !ownerReady; index += 1) {
      const inputs = Array.from(ownerHost.querySelectorAll("input"));
      ownerReady =
        inputs.length > 0 && inputs.every((input) => !input.disabled);
      if (ownerReady) {
        break;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    }
    expect(ownerReady).toBe(true);
    const ownerSiteName = Array.from(
      ownerHost.querySelectorAll("input"),
    ).find(
      (input) => input.value === referenceSiteDefinition.site.name,
    );
    expect(ownerSiteName).toBeDefined();
    await userEvent.fill(ownerSiteName!, "Owner tab draft");
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    flushSync(() => {
      duplicateRoot.render(
        createElement(
          StrictMode,
          null,
          createElement(ContentEditor, {
            csrfToken: "csrf-duplicate",
            initialRevision: browserRevision(workspaceId),
            initialPreviewUrl: "/preview/duplicate",
            activeWorkspaceUrl: "/dash?workspace=duplicate",
          }),
        ),
      );
    });
    await enterEditMode(duplicateHost);
    let duplicateReady = false;
    for (let index = 0; index < 100 && !duplicateReady; index += 1) {
      const controls = Array.from(
        duplicateHost.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
          ".editor-groups input, .editor-groups textarea",
        ),
      );
      duplicateReady =
        controls.length > 0 && controls.every((control) => !control.disabled);
      if (!duplicateReady) {
        await new Promise((resolve) => window.setTimeout(resolve, 20));
      }
    }

    expect(duplicateHost.textContent).not.toContain(
      "already open in another tab",
    );
    expect(duplicateHost.textContent).not.toContain(
      "Unsaved browser edits were recovered",
    );
    expect(duplicateReady).toBe(true);
    expect(
      (await readContentEditorOutbox(workspaceId))?.edits,
    ).toContainEqual({
      path: "site_foundry_reference.name",
      format: "plainText",
      baseValue: "Foundry Reference",
      value: "Owner tab draft",
    });

    await clearContentEditorOutbox(workspaceId);
  });

  it("recovers a legacy plain CTA outbox record into the rich-text editor", async () => {
    const workspaceId = "workspace_browser_legacy_rich_text";
    let attemptedBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        attemptedBody =
          typeof init?.body === "string"
            ? JSON.parse(init.body) as unknown
            : undefined;
        return new Promise<Response>(() => undefined);
      }),
    );
    await writeContentEditorOutbox({
      workspaceId,
      baseRevision: 4,
      edits: [
        {
          path: "section_contact.body",
          baseValue:
            "Bring the rough notes, the constraints, and the thing that still feels unresolved. That is enough to start.",
          value: "Recovered legacy CTA copy.",
        },
      ],
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);

    flushSync(() => {
      root.render(
        createElement(ContentEditor, {
          csrfToken: "mutation-token",
          initialRevision: browserRevision(workspaceId),
          initialPreviewUrl: "/preview",
          activeWorkspaceUrl: "/dash",
        }),
      );
    });
    for (let index = 0; index < 100 && attemptedBody === undefined; index += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    }

    expect(attemptedBody).toEqual(
      expect.objectContaining({
        edits: [
          expect.objectContaining({
            path: "section_contact.body",
            format: "richText",
            value: expect.stringContaining("Recovered legacy CTA copy."),
          }),
        ],
      }),
    );
    expect(host.textContent).toContain("Recovered legacy CTA copy.");
    expect(host.textContent).toContain(
      "Unsaved browser edits were recovered.",
    );
    await enterEditMode(host);
    const recoveredCanvas = await selectEditorSection(host, "section_contact");
    const editable = recoveredCanvas.querySelector<HTMLElement>(
      '[id="section_contact-rendered-body-editor"]',
    );
    expect(editable?.closest("label")).toBeNull();
    expect(editable?.getAttribute("aria-label")).toBe("Body");
    expect(
      recoveredCanvas.querySelector(
        '[data-rendered-rich-text-editor="section_contact"] .rich-text-toolbar',
      )?.getAttribute(
        "aria-label",
      ),
    ).toBe("Text formatting for Body");
  });

  it("preserves an incompatible rich-text recovery conflict when use-my-value is rejected", async () => {
    const workspaceId = "workspace_browser_invalid_rich_text_recovery";
    const callToAction = referenceSiteDefinition.home.sections.find(
      (section) => section.type === "callToAction",
    )!;
    if (callToAction.type !== "callToAction") {
      throw new Error("expected_call_to_action_fixture");
    }
    await writeContentEditorOutbox({
      workspaceId,
      baseRevision: 4,
      edits: [
        {
          path: "section_contact.body",
          format: "plainText",
          baseValue: serializeRichTextDocument(callToAction.body),
          value: "This explicit plain-text format is incompatible.",
        },
      ],
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);

    flushSync(() => {
      root.render(
        createElement(ContentEditor, {
          csrfToken: "mutation-token",
          initialRevision: browserRevision(workspaceId),
          initialPreviewUrl: "/preview",
          activeWorkspaceUrl: "/dash",
        }),
      );
    });
    for (
      let index = 0;
      index < 100 && !host.textContent?.includes("Use my value");
      index += 1
    ) {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    }

    await page.getByRole("button", { name: "Use my value" }).click();

    expect(host.textContent).toContain("Use my value");
    expect(host.textContent).toContain(
      "That recovered value no longer fits the current Site Definition.",
    );
    await enterEditMode(host);
    const conflictCanvas = await editorCanvasDocument(host);
    expect(
      conflictCanvas.querySelector('[id="section_contact-rendered-body-editor"]')
        ?.textContent,
    ).not.toContain("This explicit plain-text format is incompatible.");
    expect(await readContentEditorOutbox(workspaceId)).toEqual(
      expect.objectContaining({
        edits: [
          expect.objectContaining({
            path: "section_contact.body",
            format: "plainText",
          }),
        ],
      }),
    );
  });
});
