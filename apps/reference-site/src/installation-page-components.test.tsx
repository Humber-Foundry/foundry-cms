import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  ContentApprovalInvalidError,
  ContentRevisionValidationError,
  createContentActorId,
  createContentApprovalFingerprint,
  createContentRevisionApplication,
  createContentWorkspaceId,
  createInMemoryContentRevisionStore,
  sha256CanonicalJson,
} from "@humber-foundry/application";
import { pageCompositionContract } from "@humber-foundry/site-definition";

import { SiteRenderer, SiteSection } from "../components/site-renderer";
import {
  definitionToPuckData,
  pageCompositionChanged,
  puckDataToDefinition,
} from "./page-composition-puck";
import {
  installedPageComponentRegistry,
} from "../foundry/page-components";
import {
  installedSiteDefinition,
  isInstalledSiteDefinition,
} from "../foundry/site-definition";

describe("installation-owned page components", () => {
  it("uses the same real renderer for public and exact-preview projections", () => {
    const publicMarkup = renderToStaticMarkup(
      <SiteRenderer definition={installedSiteDefinition} />,
    );
    const previewMarkup = renderToStaticMarkup(
      <SiteRenderer
        definition={structuredClone(installedSiteDefinition)}
        mediaDelivery="authenticated"
        mediaAccessToken="preview-token"
      />,
    );

    expect(publicMarkup).toContain("There is useful information in the middle of the mess.");
    expect(publicMarkup).toContain('class="connector-grid"');
    expect(publicMarkup).toContain('alt="An illustrated workshop table with people sharing notes"');
    expect(previewMarkup).toBe(publicMarkup);
  });

  it("round-trips a visible custom edit through the installed Puck adapter", () => {
    const data = definitionToPuckData(
      installedSiteDefinition,
      installedPageComponentRegistry,
    );
    const story = data.content.find(({ type }) => type === "imageCopyStory");
    if (story === undefined) throw new Error("story_fixture_missing");
    story.props.title = "The useful question is already in the room.";

    const result = puckDataToDefinition(
      installedSiteDefinition,
      data,
      installedPageComponentRegistry,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.definition.home.sections.find(({ id }) => id === "section_story"),
    ).toMatchObject({
      type: "registered",
      props: { title: "The useful question is already in the room." },
    });
    expect(
      pageCompositionChanged(
        installedSiteDefinition,
        result.definition,
        installedPageComponentRegistry,
      ),
    ).toBe(true);
  });

  it("fails closed in rendering and installed-definition validation", () => {
    const unknown = {
      id: "section_unknown",
      type: "registered",
      component: "unknownComponent",
      props: { title: "Do not render" },
    } as const;
    const candidate = {
      ...installedSiteDefinition,
      home: {
        ...installedSiteDefinition.home,
        sections: [...installedSiteDefinition.home.sections, unknown],
      },
    };

    expect(isInstalledSiteDefinition(candidate)).toBe(false);
    expect(() =>
      renderToStaticMarkup(<SiteSection section={unknown} />),
    ).toThrow("page_component_renderer_unregistered");
  });

  it("rejects an unknown component submitted through a joined MCP draft", async () => {
    const actorId = createContentActorId("mcp-component-writer");
    const workspaceId = createContentWorkspaceId("workspace_component_security");
    const application = createContentRevisionApplication({
      siteDefinition: installedSiteDefinition,
      pageComponents: installedPageComponentRegistry,
      isDefinition: isInstalledSiteDefinition,
      store: createInMemoryContentRevisionStore(),
      workspaceId,
      actorId,
      rendererVersion: "renderer-components",
      productionBase: "published-components",
    });
    await application.commands.create({
      actorId,
      workspaceId,
      idempotencyKey: "component-security-create-0001",
    });

    await expect(
      application.commands.save({
        actorId,
        workspaceId,
        schemaVersion: installedSiteDefinition.schemaVersion,
        baseRevision: 0,
        edits: [],
        composition: {
          slotId: pageCompositionContract.slot.id,
          components: [
            ...installedSiteDefinition.home.sections,
            {
              id: "section_unknown",
              type: "registered",
              component: "unknownComponent",
              props: { title: "Do not save" },
            },
          ],
        },
        idempotencyKey: "component-security-save-0001",
        joinedAudit: {
          invocationId: "invocation-component-security",
          connectionId: "connection-component-security",
          actorId,
          siteId: installedSiteDefinition.site.id,
          operation: "content.draft.update",
          inputHash: "input-component-security",
          protocolVersion: "2025-11-25",
          scopesEvaluated: ["draft.write"],
          idempotencyKey: "component-security-save-0001",
          occurredAt: "2026-08-10T00:00:00.000Z",
          contractVersion: "foundry.mcp.audit.v1",
        },
      }),
    ).rejects.toBeInstanceOf(ContentRevisionValidationError);
  });

  it("rejects an invalid registered component before publication approval", async () => {
    const invalid = structuredClone(installedSiteDefinition);
    const story = invalid.home.sections.find(({ id }) => id === "section_story");
    if (story?.type !== "registered") throw new Error("story_fixture_missing");
    (story.props as Record<string, unknown>).imageSrc = "javascript:alert(1)";
    const revision = {
      workspaceId: createContentWorkspaceId("workspace_component_publication"),
      revision: 1,
      definition: invalid,
      inputs: {
        contentHash: await sha256CanonicalJson(invalid),
        schemaVersion: invalid.schemaVersion,
        rendererVersion: "renderer-components",
        productionBase: "published-components",
      },
      createdAt: "2026-08-10T00:00:00.000Z",
      createdBy: createContentActorId("membership-component-owner"),
    };

    await expect(
      createContentApprovalFingerprint(
        revision,
        "channel-components",
        "site",
        undefined,
        isInstalledSiteDefinition,
      ),
    ).rejects.toBeInstanceOf(ContentApprovalInvalidError);
  });

  it("fingerprints a valid registered composition for publication", async () => {
    const revision = {
      workspaceId: createContentWorkspaceId("workspace_component_valid_publication"),
      revision: 1,
      definition: installedSiteDefinition,
      inputs: {
        contentHash: await sha256CanonicalJson(installedSiteDefinition),
        schemaVersion: installedSiteDefinition.schemaVersion,
        rendererVersion: "renderer-components",
        productionBase: "published-components",
      },
      createdAt: "2026-08-10T00:00:00.000Z",
      createdBy: createContentActorId("membership-component-owner"),
    };

    await expect(
      createContentApprovalFingerprint(
        revision,
        "channel-components",
        "site",
        undefined,
        isInstalledSiteDefinition,
      ),
    ).resolves.toMatchObject({
      schemaVersion: installedSiteDefinition.schemaVersion,
      rendererVersion: "renderer-components",
    });
  });
});
