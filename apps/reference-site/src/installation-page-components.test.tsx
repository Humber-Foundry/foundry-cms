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
import { createVisualComponentConfig } from "../components/visual-component-editor";
import {
  definitionToPuckData,
  pageCompositionChanged,
  puckDataToDefinition,
} from "./page-composition-puck";
import {
  createPuckField,
  installedPageComponentRegistry,
} from "../foundry/page-components";
import {
  installedSiteDefinition,
  isInstalledSiteDefinition,
} from "../foundry/site-definition";

function registeredComponentFixture() {
  const definition = structuredClone(installedSiteDefinition);
  const sections = [
    ["imageCopyStory", "section_story"],
    ["photoBand", "section_gathering"],
    ["connectorCards", "section_connectors"],
    ["invitationNewsletter", "section_invitation"],
  ].map(([type, id]) =>
    installedPageComponentRegistry.createDefault(type!, id!, definition),
  );
  const fixture = {
    ...definition,
    home: {
      ...definition.home,
      sections: [
        ...definition.home.sections.slice(0, 2),
        ...sections,
        ...definition.home.sections.slice(2),
      ],
    },
  };
  if (!isInstalledSiteDefinition(fixture)) {
    throw new Error("registered_component_fixture_invalid");
  }
  return fixture;
}

describe("installation-owned page components", () => {
  it("owns validation, editor metadata, and rendering in one installed registration", () => {
    const config = createVisualComponentConfig(new Set(), installedSiteDefinition);
    expect(Object.keys(config.components)).toEqual(
      installedPageComponentRegistry.allowedComponents,
    );
    for (const registration of Object.values(
      installedPageComponentRegistry.components,
    )) {
      expect(registration.editableFields.length).toBeGreaterThan(0);
      expect(Object.keys(registration.fields).length).toBeGreaterThan(0);
      expect(registration.renderer).toBeTypeOf("function");
      expect(Object.hasOwn(config.components, registration.type)).toBe(true);
    }
  });

  it("projects an editable object schema without flattening its nested fields", () => {
    expect(createPuckField({
      control: "object",
      label: "Action",
      defaultValue: {
        label: "Continue",
        href: "#section_contact",
        internalId: "internal_action",
      },
      fields: {
        label: { control: "text", label: "Label", defaultValue: "Continue" },
        href: { control: "url", label: "Destination", defaultValue: "#section_contact" },
        internalId: {
          control: "text",
          label: "Internal identifier",
          defaultValue: "internal_action",
          editable: false,
        },
      },
    })).toEqual({
      type: "object",
      label: "Action",
      objectFields: {
        label: { type: "text", label: "Label" },
        href: { type: "text", label: "Destination" },
        internalId: {
          type: "custom",
          visible: false,
          render: expect.any(Function),
        },
      },
    });
  });

  it("uses the same real renderer for public and exact-preview projections", () => {
    const definition = registeredComponentFixture();
    const publicMarkup = renderToStaticMarkup(
      <SiteRenderer definition={definition} />,
    );
    const previewMarkup = renderToStaticMarkup(
      <SiteRenderer
        definition={structuredClone(definition)}
        mediaDelivery="authenticated"
        mediaAccessToken="preview-token"
      />,
    );

    expect(publicMarkup).toContain("Make room for a better question");
    expect(publicMarkup).toContain('class="connector-grid"');
    expect(publicMarkup).toContain('alt="People sharing ideas around a workshop table"');
    expect(previewMarkup).toBe(publicMarkup);
  });

  it("round-trips a visible custom edit through the installed Puck adapter", () => {
    const definition = registeredComponentFixture();
    const data = definitionToPuckData(
      definition,
      installedPageComponentRegistry,
    );
    const story = data.content.find(({ type }) => type === "imageCopyStory");
    if (story === undefined) throw new Error("story_fixture_missing");
    story.props.title = "The useful question is already in the room.";

    const result = puckDataToDefinition(
      definition,
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
        definition,
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
    const invalid = registeredComponentFixture();
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
    const definition = registeredComponentFixture();
    const revision = {
      workspaceId: createContentWorkspaceId("workspace_component_valid_publication"),
      revision: 1,
      definition,
      inputs: {
        contentHash: await sha256CanonicalJson(definition),
        schemaVersion: definition.schemaVersion,
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
      schemaVersion: definition.schemaVersion,
      rendererVersion: "renderer-components",
    });
  });
});
