import { createElement, StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import {
  createDefaultPageSection,
  referenceSiteDefinition,
  toPageComposition,
  type SiteDefinition,
} from "@foundry/site-definition";

import {
  createVisualComponentConfig,
  VisualComponentEditor,
  visualComponentConfig,
} from "./visual-component-editor";
import { ContentEditor } from "./content-editor";
import {
  clearStaleEdits,
  preserveStaleEdits,
} from "../src/content-editor-recovery";
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

async function waitForEditorValue(
  host: HTMLElement,
  expected: string,
): Promise<boolean> {
  for (let index = 0; index < 50; index += 1) {
    if (
      Array.from(
        host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
          ".editor-groups input, .editor-groups textarea",
        ),
      ).some(({ value }) => value === expected)
    ) {
      return true;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 20));
  }
  return false;
}

describe("visual component editor browser acceptance", () => {
  const mounted: Array<ReturnType<typeof createRoot>> = [];

  afterEach(() => {
    for (const root of mounted.splice(0)) {
      flushSync(() => root.unmount());
    }
    document.body.replaceChildren();
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
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    const designScope =
      host.querySelector(".site-canvas") ??
      iframe?.contentDocument?.querySelector(".site-canvas");
    expect(designScope?.getAttribute("data-colour-accent")).toBe("moss");

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
      "variant",
      "eyebrow",
      "title",
      "summary",
      "primaryAction",
      "secondaryAction",
    ]);
    expect(
      visualComponentConfig.components.hero.fields!.primaryAction,
    ).toEqual(expect.objectContaining({ visible: false }));
    expect(visualComponentConfig.components.hero.fields!.variant).toEqual({
      type: "select",
      label: "Variant",
      options: [
        { label: "Editorial", value: "editorial" },
        { label: "Focused", value: "focused" },
      ],
    });
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
          baseValue: "Foundry Reference",
          value: "Recovered immediately",
        },
      ],
    });
    await clearContentEditorOutbox(workspaceId);
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

    expect(
      await waitForEditorValue(
        host,
        "Unsaved evidence after the durable addition",
      ),
    ).toBe(true);
    expect(host.textContent).not.toContain(
      "some overlap newer values",
    );
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

    expect(
      await waitForEditorValue(
        host,
        "Unsaved evidence carried into the upgraded workspace",
      ),
    ).toBe(true);
    expect(
      await waitForEditorValue(
        host,
        "Destination copy survives stale recovery",
      ),
    ).toBe(true);
    expect(host.textContent).not.toContain("some overlap newer values");
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
      baseValue: "Foundry Reference",
      value: "Owner tab draft",
    });

    await clearContentEditorOutbox(workspaceId);
  });
});
