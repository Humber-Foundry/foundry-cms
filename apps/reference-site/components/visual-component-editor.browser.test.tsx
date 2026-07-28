import { createElement, StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import {
  referenceSiteDefinition,
  serializeRichTextDocument,
  type SiteDefinition,
} from "@foundry/site-definition";

import {
  createVisualComponentConfig,
  VisualComponentEditor,
  visualComponentConfig,
} from "./visual-component-editor";
import { ContentEditor } from "./content-editor";
import { RichTextEditor } from "./rich-text-editor";
import {
  clearContentEditorOutbox,
  readContentEditorOutbox,
  writeContentEditorOutbox,
} from "../src/content-editor-outbox";
function browserRevision(workspaceId: string) {
  return {
    workspaceId,
    revision: 4,
    definition: referenceSiteDefinition,
    inputs: {
      contentHash: "browser-content-hash",
      schemaVersion: "1.1.0",
      rendererVersion: "renderer-browser",
      productionBase: "published-browser",
    },
    createdAt: "2026-07-27T00:00:00.000Z",
    createdBy: "membership-browser",
  } as never;
}

describe("visual component editor browser acceptance", () => {
  const mounted: Array<ReturnType<typeof createRoot>> = [];

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const root of mounted.splice(0)) {
      flushSync(() => root.unmount());
    }
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
    expect(editable!.getAttribute("aria-label")).toBe("Rendered rich text");
    expect(editable!.getAttribute("aria-describedby")).toBe("rich-editor-help");
    expect(editable!.getAttribute("aria-invalid")).toBe("false");
    expect(
      host.querySelector(".rich-text-editor")?.getAttribute("aria-label"),
    ).toBeNull();

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
      host.querySelector("#visual-component-editor-heading")?.textContent,
    ).toBe("Visual page composition");
    expect(host.textContent).toContain("Use Tab to move between controls");
    const iframe = host.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("src")).toBeNull();
    expect(iframe?.contentDocument).not.toBeNull();

    (document.activeElement as HTMLElement | null)?.blur();
    let categoryToggle: HTMLButtonElement | null = null;
    for (let index = 0; index < 30 && categoryToggle === null; index += 1) {
      await userEvent.tab();
      const focused = document.activeElement;
      if (
        focused instanceof HTMLButtonElement &&
        focused.getAttribute("aria-controls")?.startsWith(
          "puck-drawer-category-",
        )
      ) {
        categoryToggle = focused;
      }
    }
    expect(categoryToggle).not.toBeNull();
    const initiallyExpanded = categoryToggle!.getAttribute("aria-expanded");
    await userEvent.keyboard("{Enter}");
    expect(categoryToggle!.getAttribute("aria-expanded")).not.toBe(
      initiallyExpanded,
    );

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

  it("keeps protected props out of the editable field controls", () => {
    expect(Object.keys(visualComponentConfig.components.hero.fields!)).toEqual([
      "id",
      "type",
      "eyebrow",
      "title",
      "summary",
      "primaryAction",
      "secondaryAction",
    ]);
    expect(
      visualComponentConfig.components.hero.fields!.primaryAction,
    ).toEqual(expect.objectContaining({ visible: false }));
    expect(visualComponentConfig.components.services.fields!.items).toEqual(
      expect.objectContaining({ visible: false }),
    );
    const config = createVisualComponentConfig(
      new Set(["section_contact"]),
      referenceSiteDefinition,
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

    const addProof = page.getByRole("button", { name: "Add Proof" });
    await addProof.click();
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
    expect(
      host.querySelector('[id="section_contact.body-editor"]')
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
