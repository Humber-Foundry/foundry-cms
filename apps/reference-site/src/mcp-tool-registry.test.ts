import { describe, expect, it, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  registerSchema,
  unregisterSchema,
  validate as validateIndependentSchema,
  type SchemaObject,
} from "@hyperjump/json-schema/draft-2020-12";

import {
  createInMemoryPublishedSiteRepository,
  createMcpReadApplication,
  createPublishedSiteBundle,
  createSiteApplication,
  mcpAnalyticsReadScope,
  mcpCampaignDraftScope,
  mcpCampaignTestScope,
  mcpContentDraftScope,
  mcpDesignDraftScope,
  mcpInitialScope,
  mcpPublicationPublishScope,
  mcpPublicationScheduleScope,
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
    requestPublication() {},
  } as unknown as McpReadApplication;
  return createMcpToolRegistry(application);
}

function names(scopes: ReadonlyArray<string>) {
  return registry()
    .list(principal(scopes))
    .map(({ name }) => name);
}

function schemaPropertyNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(schemaPropertyNames);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    key,
    ...schemaPropertyNames(child),
  ]);
}

type JsonSchema = Readonly<Record<string, unknown>>;

function schemaExample(schema: JsonSchema): unknown {
  if (Object.hasOwn(schema, "const")) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (Array.isArray(schema.oneOf))
    return schemaExample(schema.oneOf[0] as JsonSchema);
  if (Array.isArray(schema.anyOf))
    return schemaExample(schema.anyOf[0] as JsonSchema);
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "null") return null;
  if (type === "boolean") return true;
  if (type === "integer" || type === "number")
    return typeof schema.minimum === "number" ? schema.minimum : 0;
  if (type === "array") {
    const minimum = typeof schema.minItems === "number" ? schema.minItems : 0;
    return Array.from({ length: minimum }, () =>
      schemaExample((schema.items ?? {}) as JsonSchema),
    );
  }
  if (type === "object" || schema.properties !== undefined) {
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    const required = Array.isArray(schema.required) ? schema.required : [];
    return Object.fromEntries(
      required.map((key) => [key, schemaExample(properties[String(key)] ?? {})]),
    );
  }
  if (type === "string") {
    const pattern = typeof schema.pattern === "string" ? schema.pattern : "";
    if (pattern.includes("git:"))
      return `git:${"a".repeat(40)}@content:${"b".repeat(64)}`;
    if (pattern.includes("schedule_"))
      return "schedule_0123abcd-4567-89ab-cdef-0123456789ab";
    if (pattern.includes("publish_")) return `publish_${"a".repeat(32)}`;
    if (pattern.includes("approval_")) return `approval_${"a".repeat(32)}`;
    if (pattern.includes("workspace_")) return "workspace_conformance";
    if (pattern.includes("site_")) return "site_conformance";
    if (pattern.includes("campaign_")) return `campaign_${"a".repeat(32)}`;
    if (pattern.includes("[0-9a-f]{8}") && pattern.includes("[0-9a-f]{12}"))
      return "11111111-1111-4111-8111-111111111111";
    if (pattern.includes("[0-9a-f]{64}")) return "a".repeat(64);
    if (pattern.includes("[0-9a-f]{40}")) return "a".repeat(40);
    if (pattern.includes("\\d{4}-\\d{2}-\\d{2}T"))
      return "2026-08-07T12:00:00Z";
    if (pattern.includes("\\d{4}-\\d{2}-\\d{2}")) return "2026-08-07";
    if (schema.format === "date-time") return "2026-08-07T12:00:00.000Z";
    if (schema.format === "uri" || schema.format === "uri-reference")
      return "https://example.invalid/resource";
    if (schema.format === "uuid")
      return "11111111-1111-4111-8111-111111111111";
    return "x".repeat(
      Math.max(1, typeof schema.minLength === "number" ? schema.minLength : 1),
    );
  }
  return null;
}

describe("MCP draft tool registry", () => {
  it("advertises only the publication tools granted to the connection", () => {
    expect(names([mcpInitialScope, mcpPublicationPublishScope])).toEqual([
      "foundry.site.get",
      "foundry.content.list",
      "foundry.content.get",
      "foundry.publication.request",
      "foundry.publication.status",
    ]);
    expect(names([mcpInitialScope, mcpPublicationScheduleScope])).toEqual([
      "foundry.site.get",
      "foundry.content.list",
      "foundry.content.get",
      "foundry.publication.schedule",
      "foundry.publication.status",
      "foundry.publication.cancel",
    ]);
  });

  it("rejects a malformed publication or schedule identifier at the schema", () => {
    const tools = registry().list(
      principal([
        mcpInitialScope,
        mcpPublicationScheduleScope,
        mcpPublicationPublishScope,
      ]),
    );
    const validator = new Ajv2020({
      strict: false,
      formats: { uuid: true, "date-time": true, "uri-reference": true },
    });
    const schemaFor = (name: string) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (tool === undefined) throw new Error(`missing tool ${name}`);
      return validator.compile(tool.inputSchema);
    };
    const status = schemaFor("foundry.publication.status");
    const cancel = schemaFor("foundry.publication.cancel");
    const workspaceId = "workspace_registry";
    const scheduleId = "schedule_0123abcd-4567-89ab-cdef-0123456789ab";
    const publicationId = `publish_${"a".repeat(32)}`;
    const idempotencyKey = "11111111-1111-4111-8111-111111111111";

    // Well-formed identifiers of either kind are accepted.
    expect(
      status({ workspaceId, revision: 1, operationId: publicationId }),
    ).toBe(true);
    expect(status({ workspaceId, revision: 1, operationId: scheduleId })).toBe(
      true,
    );
    // A malformed identifier is a terminal schema rejection, so it never
    // reaches an identifier constructor whose failure would surface as a
    // retryable error.
    for (const operationId of [
      "publish_!",
      "publish_short",
      `publish_${"A".repeat(32)}`,
      "schedule_not-a-uuid",
      "../publish_etc",
    ]) {
      expect(status({ workspaceId, revision: 1, operationId })).toBe(false);
    }
    // A publication instant must be the UTC form the scheduler resolves, so a
    // schema-valid offset form cannot pass here and be refused deeper.
    const schedule = schemaFor("foundry.publication.schedule");
    const scheduleInput = {
      workspaceId,
      revision: 1,
      approvalId: `approval_${"b".repeat(32)}`,
      reportingTimeZone: "America/Vancouver",
      idempotencyKey,
    };
    expect(
      schedule({ ...scheduleInput, publishAt: "2026-11-01T08:00:00Z" }),
    ).toBe(true);
    expect(
      schedule({ ...scheduleInput, publishAt: "2026-11-01T08:00:00.000Z" }),
    ).toBe(true);
    for (const publishAt of [
      "2026-11-01T08:00:00+00:00",
      "2026-11-01T08:00:00",
      "2026-11-01T08:00:00.1Z",
      "2026-11-01 08:00:00Z",
    ]) {
      expect(schedule({ ...scheduleInput, publishAt })).toBe(false);
    }
    // Cancellation names a schedule, never a publication.
    expect(
      cancel({ workspaceId, revision: 1, scheduleId, idempotencyKey }),
    ).toBe(true);
    expect(
      cancel({
        workspaceId,
        revision: 1,
        scheduleId: publicationId,
        idempotencyKey,
      }),
    ).toBe(false);
  });

  it("publishes exact revision and approval inputs without a campaign scheduling path", () => {
    const tools = registry().list(
      principal([
        mcpInitialScope,
        mcpPublicationScheduleScope,
        mcpPublicationPublishScope,
      ]),
    );
    const publicationTools = tools.filter(({ name }) =>
      name.startsWith("foundry.publication."),
    );
    const validator = new Ajv2020({
      strict: false,
      formats: {
        uuid: true,
        "date-time": true,
        "uri-reference": true,
      },
    });
    expect(publicationTools.map(({ name }) => name)).toEqual([
      "foundry.publication.request",
      "foundry.publication.schedule",
      "foundry.publication.status",
      "foundry.publication.cancel",
    ]);
    for (const tool of publicationTools) {
      expect(() => validator.compile(tool.inputSchema)).not.toThrow();
      expect(() => validator.compile(tool.outputSchema)).not.toThrow();
      expect(schemaPropertyNames(tool.inputSchema)).not.toEqual(
        expect.arrayContaining([
          "campaignId",
          "recipient",
          "segment",
          "postId",
          "approved",
        ]),
      );
    }
    expect(
      publicationTools
        .filter(({ annotations }) => annotations.readOnlyHint === false)
        .every(({ annotations }) => annotations.openWorldHint === true),
    ).toBe(true);
  });

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
      principal([mcpInitialScope, mcpContentDraftScope, mcpDesignDraftScope]),
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
          conflictResource: "foundry://workspaces/workspace_replay/revisions/4",
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
      operations: [
        {
          op: "set_token",
          token: "typography.heading",
          value: "editorial",
        },
      ],
    };

    expect(validate(input)).toBe(true);
    expect(
      validate({
        ...input,
        operations: [
          {
            op: "set_token",
            token: "typography.heading",
            value: "moss",
          },
        ],
      }),
    ).toBe(false);
    expect(
      validate({
        ...input,
        operations: [
          {
            op: "set_variant",
            componentId: "section_hero",
            value: "cards",
          },
        ],
      }),
    ).toBe(false);
  });

  it("authorizes hidden draft tools before reporting malformed arguments", async () => {
    const readOnlyPrincipal = principal([mcpInitialScope]);
    const activePrincipal = principal([mcpInitialScope, mcpContentDraftScope]);
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

describe("MCP campaign and analytics tool registry", () => {
  function fullRegistry() {
    const application = {
      openWorkspace() {},
      requestPublication() {},
      createCampaign() {},
      editCampaign() {},
      getCampaign() {},
      requestTest() {},
      testReadiness() {},
      readAnalytics() {},
    } as unknown as McpReadApplication;
    return createMcpToolRegistry(application);
  }

  function fullNames(scopes: ReadonlyArray<string>) {
    return fullRegistry()
      .list(principal(scopes))
      .map(({ name }) => name);
  }

  it("advertises campaign drafting tools only under the draft scope", () => {
    const drafting = fullNames([mcpInitialScope, mcpCampaignDraftScope]);
    expect(drafting).toEqual(
      expect.arrayContaining([
        "foundry.campaign.create",
        "foundry.campaign.edit",
        "foundry.campaign.get",
      ]),
    );
    expect(drafting).not.toEqual(
      expect.arrayContaining([
        "foundry.campaign.request_test",
        "foundry.campaign.test_readiness",
        "foundry.analytics.read",
      ]),
    );
  });

  it("advertises test tools only under the test scope", () => {
    const testing = fullNames([mcpInitialScope, mcpCampaignTestScope]);
    expect(testing).toEqual(
      expect.arrayContaining([
        "foundry.campaign.request_test",
        "foundry.campaign.test_readiness",
      ]),
    );
    expect(testing).not.toEqual(
      expect.arrayContaining([
        "foundry.campaign.create",
        "foundry.campaign.edit",
        "foundry.campaign.get",
      ]),
    );
  });

  it("advertises the analytics view only under the analytics scope", () => {
    expect(fullNames([mcpInitialScope])).not.toContain(
      "foundry.analytics.read",
    );
    expect(fullNames([mcpInitialScope, mcpAnalyticsReadScope])).toContain(
      "foundry.analytics.read",
    );
  });

  it("exposes no bulk-send, role, credential, or recipient-selection tool", () => {
    const everyName = fullNames([
      mcpInitialScope,
      mcpContentDraftScope,
      mcpDesignDraftScope,
      mcpPublicationPublishScope,
      mcpPublicationScheduleScope,
      mcpCampaignDraftScope,
      mcpCampaignTestScope,
      mcpAnalyticsReadScope,
    ]);
    for (const name of everyName) {
      expect(name).not.toMatch(
        /bulk|subscriber|recipient|role|member|credential|secret|token|password|export/iu,
      );
    }
    // No campaign scheduling or bulk authorization path exists at all.
    expect(everyName).not.toEqual(
      expect.arrayContaining([
        "foundry.campaign.schedule",
        "foundry.campaign.authorize_bulk",
        "foundry.campaign.send_bulk",
      ]),
    );
  });

  it("takes no recipient selection on a test and no raw query on analytics", () => {
    const tools = fullRegistry().list(
      principal([mcpInitialScope, mcpCampaignTestScope, mcpAnalyticsReadScope]),
    );
    const requestTest = tools.find(
      ({ name }) => name === "foundry.campaign.request_test",
    )!;
    const requestTestProperties = schemaPropertyNames(requestTest.inputSchema);
    for (const forbidden of [
      "recipient",
      "recipients",
      "recipientIds",
      "segment",
      "audience",
      "to",
      "email",
      "address",
    ]) {
      expect(requestTestProperties).not.toContain(forbidden);
    }

    const analytics = tools.find(
      ({ name }) => name === "foundry.analytics.read",
    )!;
    const analyticsProperties = schemaPropertyNames(analytics.inputSchema);
    for (const forbidden of [
      "sql",
      "query",
      "filter",
      "expression",
      "metricKey",
      "subjectId",
      "dimension",
      "select",
    ]) {
      expect(analyticsProperties).not.toContain(forbidden);
    }
    // The only view selector is a fixed enumeration.
    const validator = new Ajv2020({ strict: false, validateFormats: false });
    const validate = validator.compile(analytics.inputSchema);
    const range = { fromLocalDate: "2026-07-10", toLocalDate: "2026-08-06" };
    expect(validate({ view: "overview", range, limit: null })).toBe(true);
    expect(validate({ view: "raw_events", range, limit: null })).toBe(false);
    expect(validate({ view: "overview", range, limit: 500 })).toBe(false);
  });

  it("publishes compilable closed schemas for every campaign and analytics tool", () => {
    const tools = fullRegistry().list(
      principal([
        mcpInitialScope,
        mcpCampaignDraftScope,
        mcpCampaignTestScope,
        mcpAnalyticsReadScope,
      ]),
    );
    const validator = new Ajv2020({
      strict: false,
      formats: { uuid: true, "date-time": true, "uri-reference": true },
    });
    const newTools = tools.filter(
      ({ name }) =>
        name.startsWith("foundry.campaign.") ||
        name === "foundry.analytics.read",
    );
    expect(newTools.length).toBe(6);
    for (const tool of newTools) {
      expect(() => validator.compile(tool.inputSchema)).not.toThrow();
      expect(() => validator.compile(tool.outputSchema)).not.toThrow();
      expect(tool.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      if (tool.annotations.readOnlyHint === false) {
        expect(schemaPropertyNames(tool.inputSchema)).toContain(
          "idempotencyKey",
        );
      }
    }
    // The create tool accepts the exact campaign editable fields and nothing
    // that would let an agent set an audience, sender, or recipient.
    const create = newTools.find(
      ({ name }) => name === "foundry.campaign.create",
    )!;
    const createInput = new Ajv2020({
      strict: false,
      formats: { uuid: true },
    }).compile(create.inputSchema);
    const validCreate = {
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      subject: "August news",
      previewText: "What changed",
      callToAction: { label: "Read", href: "https://example.test/post" },
      emailContent: {
        version: "1.0.0",
        type: "document",
        children: [],
      },
    };
    expect(createInput(validCreate)).toBe(true);
    expect(
      createInput({ ...validCreate, senderIdentityId: "sender_primary" }),
    ).toBe(false);
    expect(
      createInput({ ...validCreate, audienceDefinition: { id: "x" } }),
    ).toBe(false);
  });

  it("matches the reviewed complete MCP tool-schema snapshot", () => {
    const tools = fullRegistry().list(
      principal([
        mcpInitialScope,
        mcpContentDraftScope,
        mcpDesignDraftScope,
        mcpPublicationPublishScope,
        mcpPublicationScheduleScope,
        mcpCampaignDraftScope,
        mcpCampaignTestScope,
        mcpAnalyticsReadScope,
      ]),
    );

    expect(
      tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchemaSha256: createHash("sha256")
          .update(JSON.stringify(tool.inputSchema))
          .digest("hex"),
        outputSchemaSha256: createHash("sha256")
          .update(JSON.stringify(tool.outputSchema))
          .digest("hex"),
        annotations: tool.annotations,
        execution: tool.execution,
      })),
    ).toMatchSnapshot();
  });

  it("keeps the normative tool catalog synchronized with every runtime descriptor", () => {
    const catalog = readFileSync(
      new URL("../../../docs/mcp/catalog.md", import.meta.url),
      "utf8",
    );
    const toolTable = catalog
      .split("## Tool catalog")[1]!
      .split("## Representative schemas")[0]!;
    const documented = toolTable
      .split("\n")
      .flatMap((line) => {
        const cells = line.split("|").map((cell) => cell.trim());
        const name = cells[1]?.match(/^`(foundry\.[a-z_.]+)`$/u)?.[1];
        return name === undefined
          ? []
          : [{ name, description: cells[3] }];
      });
    const runtime = fullRegistry()
      .list(
        principal([
          mcpInitialScope,
          mcpContentDraftScope,
          mcpDesignDraftScope,
          mcpPublicationPublishScope,
          mcpPublicationScheduleScope,
          mcpCampaignDraftScope,
          mcpCampaignTestScope,
          mcpAnalyticsReadScope,
        ]),
      )
      .map(({ name, description }) => ({ name, description }));
    expect(documented).toEqual(runtime);
  });

  it("keeps the normative permission matrix synchronized with every runtime descriptor", () => {
    const matrix = readFileSync(
      new URL("../../../docs/mcp/permission-matrix.md", import.meta.url),
      "utf8",
    );
    const toolTable = matrix
      .split("## Tool-to-scope matrix")[1]!
      .split("## Data classification and output")[0]!;
    const documented = toolTable
      .split("\n")
      .flatMap((line) => {
        const cells = line.split("|").map((cell) => cell.trim());
        const name = cells[1]?.match(/^`(foundry\.[a-z_.]+)`$/u)?.[1];
        return name === undefined
          ? []
          : [{ name, scopes: cells[2]?.replaceAll("`", "") }];
      });
    const runtime = fullRegistry()
      .list(
        principal([
          mcpInitialScope,
          mcpContentDraftScope,
          mcpDesignDraftScope,
          mcpPublicationPublishScope,
          mcpPublicationScheduleScope,
          mcpCampaignDraftScope,
          mcpCampaignTestScope,
          mcpAnalyticsReadScope,
        ]),
      )
      .map(({ name }) => name);
    expect(documented.map(({ name }) => name).sort()).toEqual(runtime.sort());
    expect(
      Object.fromEntries(
        documented.map(({ name, scopes }) => [name, scopes]),
      ),
    ).toEqual({
        "foundry.site.get": "site.read",
        "foundry.content.list": "site.read",
        "foundry.content.get": "site.read",
        "foundry.workspace.open": "content.draft or design.draft",
        "foundry.workspace.get": "matching draft scope",
        "foundry.content.patch": "content.draft",
        "foundry.design.patch": "design.draft",
        "foundry.preview.prepare": "matching draft scopes",
        "foundry.campaign.create": "campaign.draft",
        "foundry.campaign.edit": "campaign.draft",
        "foundry.campaign.get": "campaign.draft",
        "foundry.campaign.request_test": "campaign.test",
        "foundry.campaign.test_readiness": "campaign.test",
        "foundry.publication.schedule":
          "publication.schedule + matching draft scopes",
        "foundry.publication.cancel": "publication.schedule",
        "foundry.publication.request":
          "publication.publish + matching draft scopes",
        "foundry.publication.status":
          "publication.publish or publication.schedule",
        "foundry.analytics.read": "analytics.read",
      });
  });

  it("independently validates all advertised schemas with success and error examples", async () => {
    const tools = fullRegistry().list(
      principal([
        mcpInitialScope,
        mcpContentDraftScope,
        mcpDesignDraftScope,
        mcpPublicationPublishScope,
        mcpPublicationScheduleScope,
        mcpCampaignDraftScope,
        mcpCampaignTestScope,
        mcpAnalyticsReadScope,
      ]),
    );
    expect(tools).toHaveLength(18);

    for (const tool of tools) {
      const inputSchema = JSON.parse(
        JSON.stringify(tool.inputSchema),
      ) as SchemaObject;
      const outputSchema = JSON.parse(
        JSON.stringify(tool.outputSchema),
      ) as SchemaObject;
      const inputUri = `https://conformance.foundry.invalid/all/${tool.name}/input`;
      const outputUri = `https://conformance.foundry.invalid/all/${tool.name}/output`;
      registerSchema(
        inputSchema,
        inputUri,
        "https://json-schema.org/draft/2020-12/schema",
      );
      registerSchema(
        outputSchema,
        outputUri,
        "https://json-schema.org/draft/2020-12/schema",
      );
      try {
        const input = schemaExample(inputSchema as JsonSchema) as Record<
          string,
          unknown
        >;
        if (
          tool.name === "foundry.campaign.create" ||
          tool.name === "foundry.campaign.edit"
        ) {
          input.emailContent = {
            version: "1.0.0",
            type: "document",
            children: [],
          };
        }
        expect(
          (await validateIndependentSchema(inputUri, input as never)).valid,
          `${tool.name} input`,
        ).toBe(true);
        expect(
          (
            await validateIndependentSchema(inputUri, {
              ...(input as Record<string, unknown>),
              unexpectedConformanceField: true,
            } as never)
          ).valid,
          `${tool.name} closed input`,
        ).toBe(false);

        const variants = (outputSchema as JsonSchema)
          .oneOf as ReadonlyArray<JsonSchema>;
        expect(variants).toHaveLength(2);
        for (const [kind, variant] of [
          ["success", variants[0]],
          ["error", variants[1]],
        ] as const) {
          const example = schemaExample(variant) as Record<string, unknown>;
          if (kind === "success" && tool.name === "foundry.content.get") {
            (example.result as Record<string, unknown>).document =
              referenceSiteDefinition.home;
          }
          if (kind === "success" && tool.name === "foundry.workspace.get") {
            const result = example.result as Record<string, unknown>;
            for (const revisionName of ["base", "current"]) {
              (result[revisionName] as Record<string, unknown>).definition =
                referenceSiteDefinition;
            }
          }
          if (kind === "success" && tool.name === "foundry.campaign.get") {
            (example.result as Record<string, unknown>).emailContent = {
              version: "1.0.0",
              type: "document",
              children: [],
            };
          }
          expect(
            (
              await validateIndependentSchema(
                outputUri,
                example as never,
                "BASIC",
              )
            ).valid,
            `${tool.name} ${kind} output`,
          ).toBe(true);
        }
      } finally {
        unregisterSchema(inputUri);
        unregisterSchema(outputUri);
      }
    }
  });

  it("hides campaign and analytics tools when the application omits them", () => {
    const readOnly = {
      openWorkspace() {},
      requestPublication() {},
    } as unknown as McpReadApplication;
    const registryValue = createMcpToolRegistry(readOnly);
    const listed = registryValue
      .list(
        principal([
          mcpInitialScope,
          mcpCampaignDraftScope,
          mcpCampaignTestScope,
          mcpAnalyticsReadScope,
        ]),
      )
      .map(({ name }) => name);
    expect(listed.some((name) => name.startsWith("foundry.campaign."))).toBe(
      false,
    );
    expect(listed).not.toContain("foundry.analytics.read");
    expect(registryValue.get("foundry.campaign.create")).toBeNull();
    expect(registryValue.get("foundry.analytics.read")).toBeNull();
  });
});
