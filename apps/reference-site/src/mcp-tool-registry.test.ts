import { describe, expect, it, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";

import {
  createInMemoryPublishedSiteRepository,
  createMcpReadApplication,
  createPublishedSiteBundle,
  createSiteApplication,
  mcpContentDraftScope,
  mcpDesignDraftScope,
  mcpInitialScope,
  type McpConnectionPrincipal,
  type McpReadAuditEvent,
} from "@foundry/application";
import { referenceSiteDefinition } from "@foundry/site-definition";

import {
  createMcpToolRegistry,
  type McpReadApplication,
} from "./mcp-tool-registry";

function principal(scopes: ReadonlyArray<string>): McpConnectionPrincipal {
  return {
    connectionId: "connection-registry",
    actorId: "actor-registry",
    clientId: "https://client.example/mcp.json",
    siteId: referenceSiteDefinition.site.id,
    scopes,
  };
}

function registry() {
  const application = {
    openWorkspace() {},
  } as unknown as McpReadApplication;
  return createMcpToolRegistry(application);
}

function names(scopes: ReadonlyArray<string>) {
  return registry().list(principal(scopes)).map(({ name }) => name);
}

function schemaPropertyNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(schemaPropertyNames);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    key,
    ...schemaPropertyNames(child),
  ]);
}

describe("MCP draft tool registry", () => {
  it("omits mutation tools until the matching Owner-granted scope exists", () => {
    expect(names([mcpInitialScope])).toEqual([
      "foundry.site.get",
      "foundry.content.list",
      "foundry.content.get",
    ]);
    expect(names([mcpInitialScope, mcpContentDraftScope])).toEqual([
      "foundry.site.get",
      "foundry.content.list",
      "foundry.content.get",
      "foundry.workspace.open",
      "foundry.workspace.get",
      "foundry.content.patch",
      "foundry.preview.prepare",
    ]);
    expect(names([mcpInitialScope, mcpDesignDraftScope])).toEqual([
      "foundry.site.get",
      "foundry.content.list",
      "foundry.content.get",
      "foundry.workspace.open",
      "foundry.workspace.get",
      "foundry.design.patch",
      "foundry.preview.prepare",
    ]);
  });

  it("publishes closed typed schemas without site, file, code or approval-creation inputs", () => {
    const tools = registry().list(
      principal([
        mcpInitialScope,
        mcpContentDraftScope,
        mcpDesignDraftScope,
      ]),
    );
    const mutationTools = tools.filter(
      ({ annotations }) => annotations.readOnlyHint === false,
    );
    const validator = new Ajv2020({
      strict: false,
      validateFormats: false,
    });
    expect(mutationTools.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/approv|file|code|html|css|javascript/iu),
      ]),
    );
    for (const tool of mutationTools) {
      expect(() => validator.compile(tool.inputSchema)).not.toThrow();
      expect(() => validator.compile(tool.outputSchema)).not.toThrow();
      expect(tool.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      const properties = schemaPropertyNames(tool.inputSchema);
      expect(properties).not.toEqual(
        expect.arrayContaining([
          "siteId",
          "path",
          "file",
          "code",
          "html",
          "css",
          "javascript",
          "approvalId",
          "approved",
        ]),
      );
      if (tool.annotations.readOnlyHint === false) {
        expect(properties).toContain("idempotencyKey");
        expect(properties).toContain("expectedRevision");
      }
    }
    expect(
      mutationTools.find(({ name }) => name === "foundry.workspace.open")
        ?.annotations.destructiveHint,
    ).toBe(false);
    expect(
      mutationTools.find(({ name }) => name === "foundry.preview.prepare")
        ?.annotations.destructiveHint,
    ).toBe(false);
    expect(
      mutationTools.find(({ name }) => name === "foundry.content.patch")
        ?.annotations.destructiveHint,
    ).toBe(true);
  });

  it("accepts replay-aware mutation envelopes and actionable stale errors", () => {
    const contentPatch = registry()
      .list(principal([mcpInitialScope, mcpContentDraftScope]))
      .find(({ name }) => name === "foundry.content.patch")!;
    const validate = new Ajv2020({
      strict: false,
      validateFormats: false,
    }).compile(contentPatch.outputSchema);
    expect(
      validate({
        contractVersion: "foundry.mcp.v1",
        invocationId: "invocation-replay",
        result: {
          workspaceId: "workspace_replay",
          revision: 1,
          contentHash: "a".repeat(64),
          schemaVersion: referenceSiteDefinition.schemaVersion,
          validation: { valid: true, issues: [] },
          replayed: true,
          previewArtifact: "b".repeat(64),
        },
        meta: {
          replayed: true,
          observedAt: "2026-07-29T20:00:00.000Z",
        },
      }),
    ).toBe(true);
    expect(
      validate({
        contractVersion: "foundry.mcp.v1",
        invocationId: "invocation-stale",
        error: {
          code: "STALE_REVISION",
          message: "The workspace revision changed.",
          retryable: false,
          requiredScopes: [],
          latestRevision: 4,
          conflictResource:
            "foundry://workspaces/workspace_replay/revisions/4",
        },
        meta: {
          replayed: false,
          observedAt: "2026-07-29T20:00:00.000Z",
        },
      }),
    ).toBe(true);
  });

  it("pairs each advertised design target with only its registered values", () => {
    const designPatch = registry()
      .list(principal([mcpInitialScope, mcpDesignDraftScope]))
      .find(({ name }) => name === "foundry.design.patch")!;
    const validate = new Ajv2020({
      strict: false,
      formats: { uuid: true },
    }).compile(designPatch.inputSchema);
    const input = {
      workspaceId: "workspace_design_contract",
      expectedRevision: 0,
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      operations: [{
        op: "set_token",
        token: "typography.heading",
        value: "editorial",
      }],
    };

    expect(validate(input)).toBe(true);
    expect(
      validate({
        ...input,
        operations: [{
          op: "set_token",
          token: "typography.heading",
          value: "moss",
        }],
      }),
    ).toBe(false);
    expect(
      validate({
        ...input,
        operations: [{
          op: "set_variant",
          componentId: "section_hero",
          value: "cards",
        }],
      }),
    ).toBe(false);
  });

  it("authorizes hidden draft tools before reporting malformed arguments", async () => {
    const readOnlyPrincipal = principal([mcpInitialScope]);
    const activePrincipal = principal([
      mcpInitialScope,
      mcpContentDraftScope,
    ]);
    const audit: McpReadAuditEvent[] = [];
    const read = createMcpReadApplication({
      site: createSiteApplication({
        siteId: referenceSiteDefinition.site.id,
        publishedSites: createInMemoryPublishedSiteRepository([
          createPublishedSiteBundle(referenceSiteDefinition),
        ]),
      }),
      siteMetadata: {
        canonicalUrl: "https://foundry.example",
        locale: "en-CA",
        timeZone: "America/Vancouver",
        async getLiveRelease() {
          return null;
        },
      },
      connections: {
        async findCurrentConnection() {
          return { ...activePrincipal, status: "active" as const };
        },
        async recordInvocation(event) {
          audit.push(event);
        },
      },
      cursors: {
        async encode() {
          return "unused";
        },
        async decode() {
          throw new Error("unused");
        },
      },
      createInvocationId: () => "invocation-hidden-draft",
      now: () => "2026-07-29T20:00:00.000Z",
    });
    const openWorkspace = vi.fn(async () => {
        throw new Error("must_not_run");
    });
    const draftCapable = Object.assign(read, {
      openWorkspace,
    }) as McpReadApplication;
    const contentPatch = createMcpToolRegistry(draftCapable).get(
      "foundry.content.patch",
    );
    if (contentPatch === null) throw new Error("expected_content_patch");

    await expect(
      contentPatch.execute(
        readOnlyPrincipal,
        { malformed: true },
        {
          throwIfExpired() {},
          run: (operation) => operation(),
          finishDurably: (operation) => operation(),
        },
      ),
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_SCOPE",
      requiredScopes: [mcpContentDraftScope],
    });
    expect(audit).toEqual([
      expect.objectContaining({
        operation: "foundry.content.patch",
        scopesEvaluated: [mcpContentDraftScope],
        outcome: "denied",
        reason: "INSUFFICIENT_SCOPE",
      }),
    ]);

    await expect(
      createMcpToolRegistry(draftCapable)
        .get("foundry.workspace.open")!
        .execute(
          activePrincipal,
          {
            expectedRevision: 0,
            idempotencyKey: "not-a-uuid-key-0001",
          },
          {
            throwIfExpired() {},
            run: (operation) => operation(),
            finishDurably: (operation) => operation(),
          },
        ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(openWorkspace).not.toHaveBeenCalled();
  });
});
