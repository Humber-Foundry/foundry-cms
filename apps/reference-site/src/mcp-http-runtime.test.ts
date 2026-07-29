import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import Ajv2020 from "ajv/dist/2020.js";

import {
  createInMemoryPublishedSiteRepository,
  createMcpReadApplication,
  createPublishedSiteBundle,
  createSiteApplication,
  type McpConnectionGrant,
  type McpReadAuditEvent,
} from "@foundry/application";
import {
  createBlogPostId,
  createRichTextDocumentFromPlainText,
  referenceSiteDefinition,
  type SiteDefinition,
} from "@foundry/site-definition";

import {
  createMcpHttpRuntime,
  createSignedMcpCursorCodec,
  type McpAuthorizationGrantInput,
  type McpAuthorizationRuntimeStore,
} from "./mcp-http-runtime";

const canonicalOrigin = "https://foundry.example";
const resourceUri = `${canonicalOrigin}/api/foundry-mcp`;
const signingSecret =
  "test-only-mcp-signing-secret-with-at-least-thirty-two-characters";
const clientId = "https://client.example/metadata.json";
const redirectUri = "https://client.example/callback";
const now = new Date("2026-07-29T18:00:00.000Z");

function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function digest(value: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return encodeBase64Url(new Uint8Array(bytes));
}

function createStore({
  allowRateLimit = true,
  beforeFindCurrentConnection,
  beforeConsumeRateLimit,
  beforeRecordInvocation,
}: {
  allowRateLimit?: boolean | ((call: number) => boolean);
  beforeFindCurrentConnection?: (call: number) => Promise<void>;
  beforeConsumeRateLimit?: (call: number) => Promise<void>;
  beforeRecordInvocation?: () => Promise<void>;
} = {}) {
  const connections = new Map<string, McpConnectionGrant>();
  const codes = new Map<
    string,
    McpAuthorizationGrantInput & { consumed: boolean }
  >();
  const audit: McpReadAuditEvent[] = [];
  const rateLimitInputs: Array<{
    bucketKey: string;
    limit: number;
  }> = [];
  const connectionLookupInputs: Array<{
    connectionId: string;
    siteId: string;
  }> = [];
  let connectionLookupCount = 0;
  let rateLimitCount = 0;
  const refreshTokens = new Map<
    string,
    {
      familyId: string;
      connectionId: string;
      clientId: string;
      consumed: boolean;
      revoked: boolean;
    }
  >();
  const store: McpAuthorizationRuntimeStore = {
    async createAuthorizationGrant(input) {
      connections.set(input.connectionId, {
        connectionId: input.connectionId,
        actorId: input.actorId,
        siteId: input.siteId,
        clientId: input.clientId,
        scopes: ["site.read"],
        status: "active",
      });
      codes.set(input.codeHash, { ...input, consumed: false });
    },
    async exchangeAuthorizationCode(input) {
      const code = codes.get(input.codeHash);
      if (
        code === undefined ||
        code.consumed ||
        code.codeChallenge !== input.codeChallenge ||
        code.clientId !== input.clientId ||
        code.redirectUri !== input.redirectUri ||
        code.expiresAt <= input.now
      ) {
        return null;
      }
      code.consumed = true;
      refreshTokens.set(input.refreshTokenHash, {
        familyId: input.refreshFamilyId,
        connectionId: code.connectionId,
        clientId: input.clientId,
        consumed: false,
        revoked: false,
      });
      return {
        ...connections.get(code.connectionId)!,
        codeChallenge: code.codeChallenge,
      };
    },
    async findCurrentConnection(input) {
      connectionLookupCount += 1;
      connectionLookupInputs.push(input);
      await beforeFindCurrentConnection?.(connectionLookupCount);
      const connection = connections.get(input.connectionId);
      return connection?.siteId === input.siteId ? connection : null;
    },
    async revokeConnection(input) {
      const connection = connections.get(input.connectionId);
      if (connection?.siteId !== input.siteId) return false;
      connections.set(input.connectionId, {
        ...connection,
        status: "revoked",
      });
      return true;
    },
    async rotateRefreshToken(input) {
      const existing = refreshTokens.get(input.tokenHash);
      if (
        existing === undefined ||
        existing.clientId !== input.clientId ||
        existing.revoked
      ) {
        return { state: "invalid" };
      }
      if (existing.consumed) {
        for (const token of refreshTokens.values()) {
          if (token.familyId === existing.familyId) token.revoked = true;
        }
        const connection = connections.get(existing.connectionId)!;
        connections.set(existing.connectionId, {
          ...connection,
          status: "revoked",
        });
        return { state: "reuse_detected" };
      }
      existing.consumed = true;
      refreshTokens.set(input.nextTokenHash, {
        ...existing,
        consumed: false,
      });
      return {
        state: "rotated",
        connection: connections.get(existing.connectionId)!,
      };
    },
    async consumeRateLimit(input) {
      rateLimitCount += 1;
      await beforeConsumeRateLimit?.(rateLimitCount);
      rateLimitInputs.push(input);
      return typeof allowRateLimit === "function"
        ? allowRateLimit(rateLimitCount)
        : allowRateLimit;
    },
    async recordInvocation(event) {
      await beforeRecordInvocation?.();
      audit.push(event);
    },
  };
  return {
    store,
    connections,
    audit,
    rateLimitInputs,
    connectionLookupInputs,
  };
}

function fixture(
  options: {
    allowRateLimit?: boolean | ((call: number) => boolean);
    contentCount?: number;
    requestTimeoutMs?: number;
    beforeFindCurrentConnection?: (call: number) => Promise<void>;
    beforeConsumeRateLimit?: (call: number) => Promise<void>;
    beforeRecordInvocation?: () => Promise<void>;
  } = {},
) {
  const state = createStore(options);
  const contentCount = options.contentCount ?? 0;
  const definition = {
    ...referenceSiteDefinition,
    blog: {
      ...referenceSiteDefinition.blog,
      posts: Array.from({ length: contentCount }, (_, index) => ({
        id: createBlogPostId(
          `00000000-0000-4000-8000-${(index + 1)
            .toString(16)
            .padStart(12, "0")}`,
        ),
        revision: 1,
        collectionState: "active" as const,
        targetVisibility: "public" as const,
        slug: `post-${index + 1}`,
        title: `Post ${index + 1}`,
        excerpt: `Published post ${index + 1}.`,
        seo: {
          title: `Post ${index + 1}`,
          description: `Published post ${index + 1}.`,
        },
        body: createRichTextDocumentFromPlainText(
          `Published post ${index + 1}.`,
        ),
      })),
    },
  } satisfies SiteDefinition;
  const cursors = createSignedMcpCursorCodec({
    secret: signingSecret,
    now: () => now,
  });
  const readApplication = createMcpReadApplication({
    site: createSiteApplication({
      siteId: referenceSiteDefinition.site.id,
      publishedSites: createInMemoryPublishedSiteRepository([
        createPublishedSiteBundle(definition),
      ]),
    }),
    siteMetadata: {
      canonicalUrl: canonicalOrigin,
      locale: "en-CA",
      timeZone: "America/Vancouver",
      async getLiveRelease() {
        return {
          gitSha: "a".repeat(40),
          releaseId: "release-1",
          observedAt: "2026-07-29T17:59:00.000Z",
        };
      },
    },
    connections: state.store,
    cursors,
    createInvocationId: () => crypto.randomUUID(),
    now: () => now.toISOString(),
  });
  const runtime = createMcpHttpRuntime({
    resourceUri,
    authorizationIssuer: canonicalOrigin,
    canonicalOrigin,
    signingSecret,
    siteId: referenceSiteDefinition.site.id,
    siteName: referenceSiteDefinition.site.name,
    store: state.store,
    readApplication,
    cursors,
    registeredClients: {
      [clientId]: {
        name: "Test MCP Client",
        redirectUris: [redirectUri],
      },
    },
    authenticateOwner: async () => ({
      membershipId: "membership-owner",
      csrfToken: "owner-bound-csrf",
    }),
    createAuthorizationCode: () => "opaque-authorization-code",
    createConnectionId: () => "11111111-1111-4111-8111-111111111111",
    createActorId: () => "22222222-2222-4222-8222-222222222222",
    createTokenId: () => "33333333-3333-4333-8333-333333333333",
    createRefreshToken: (() => {
      let refresh = 0;
      return () => `refresh-token-${++refresh}-${"r".repeat(43)}`;
    })(),
    createRefreshFamilyId: () => "44444444-4444-4444-8444-444444444444",
    requestTimeoutMs: options.requestTimeoutMs,
    now: () => now,
  });
  return { runtime, ...state };
}

async function authorize(
  runtime: ReturnType<typeof createMcpHttpRuntime>,
  verifier: string,
) {
  const challenge = await digest(verifier);
  const authorize = await runtime.fetch(
    new Request(`${resourceUri}/oauth/authorize`, {
      method: "POST",
      headers: {
        origin: canonicalOrigin,
        "content-type": "application/json",
        "x-foundry-csrf": "verified-by-owner-boundary",
      },
      body: JSON.stringify({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        resource: resourceUri,
        scope: "site.read",
        state: "client-state",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
    }),
  );
  expect(authorize.status).toBe(303);
  const redirected = new URL(authorize.headers.get("location")!);
  expect(redirected.origin + redirected.pathname).toBe(redirectUri);
  expect(redirected.searchParams.get("state")).toBe("client-state");
  return redirected.searchParams.get("code")!;
}

async function authorizeAndExchange(
  runtime: ReturnType<typeof createMcpHttpRuntime>,
) {
  const verifier = "v".repeat(64);
  const code = await authorize(runtime, verifier);
  const token = await runtime.fetch(
    new Request(`${resourceUri}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        resource: resourceUri,
        code_verifier: verifier,
      }),
    }),
  );
  expect(token.status).toBe(200);
  const body = (await token.json()) as {
    access_token: string;
    refresh_token: string;
    scope: string;
    token_type: string;
  };
  expect(body).toEqual(
    expect.objectContaining({
      access_token: expect.any(String),
      refresh_token: expect.any(String),
      scope: "site.read",
      token_type: "Bearer",
    }),
  );
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
  };
}

function rpcRequest(token: string, body: unknown) {
  return new Request(resourceUri, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      origin: canonicalOrigin,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify(body),
  });
}

async function forgedToken(overrides: {
  connectionId: string;
  actorId: string;
  audience?: string;
  subject?: string;
  siteId?: string;
}) {
  const issuedAt = Math.floor(now.getTime() / 1_000);
  return new SignJWT({
    resource: resourceUri,
    token_type: "access_token",
    connection_id: overrides.connectionId,
    client_id: clientId,
    site_id: overrides.siteId ?? referenceSiteDefinition.site.id,
    scope: "site.read",
  })
    .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
    .setIssuer(canonicalOrigin)
    .setAudience(overrides.audience ?? resourceUri)
    .setSubject(overrides.subject ?? overrides.actorId)
    .setIssuedAt(issuedAt)
    .setNotBefore(issuedAt)
    .setExpirationTime(issuedAt + 300)
    .sign(new TextEncoder().encode(signingSecret));
}

describe("production MCP HTTP runtime", () => {
  it("publishes protected-resource and authorization-server discovery", async () => {
    const { runtime } = fixture();

    const protectedMetadata = await runtime.fetch(
      new Request(
        `${canonicalOrigin}/.well-known/oauth-protected-resource/api/foundry-mcp`,
      ),
    );
    await expect(protectedMetadata.json()).resolves.toEqual({
      resource: resourceUri,
      authorization_servers: [canonicalOrigin],
      scopes_supported: ["site.read"],
      bearer_methods_supported: ["header"],
      resource_name: `${referenceSiteDefinition.site.name} — Foundry CMS`,
    });

    const authorizationMetadata = await runtime.fetch(
      new Request(
        `${canonicalOrigin}/.well-known/oauth-authorization-server`,
      ),
    );
    await expect(authorizationMetadata.json()).resolves.toEqual(
      expect.objectContaining({
        issuer: canonicalOrigin,
        authorization_endpoint: `${resourceUri}/oauth/authorize`,
        token_endpoint: `${resourceUri}/oauth/token`,
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        scopes_supported: ["site.read"],
      }),
    );
  });

  it("renders a no-side-effect Owner consent page before creating a connection", async () => {
    const { runtime, connections } = fixture();
    const verifier = "v".repeat(64);
    const url = new URL(`${resourceUri}/oauth/authorize`);
    for (const [name, value] of Object.entries({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      resource: resourceUri,
      scope: "site.read",
      state: "client-state",
      code_challenge: await digest(verifier),
      code_challenge_method: "S256",
    })) {
      url.searchParams.set(name, value);
    }

    const response = await runtime.fetch(new Request(url));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(
      "form-action 'self'",
    );
    const document = await response.text();
    expect(document).toContain("Approve read-only connection");
    expect(document).toContain('name="csrf_token"');
    expect(document).not.toContain(signingSecret);
    expect(connections.size).toBe(0);
  });

  it("completes authorization code + PKCE and exposes typed read-only catalogs", async () => {
    const { runtime } = fixture();
    const { accessToken: token } = await authorizeAndExchange(runtime);

    const initialize = await runtime.fetch(
      rpcRequest(token, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
    );
    await expect(initialize.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: expect.objectContaining({
        protocolVersion: "2025-11-25",
        serverInfo: expect.objectContaining({
          description: expect.stringContaining("foundry.mcp.v1"),
        }),
      }),
    });

    const tools = await runtime.fetch(
      rpcRequest(token, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    );
    const toolsBody = (await tools.json()) as {
      result: {
        tools: Array<{ name: string; inputSchema: unknown }>;
        nextCursor: string | null;
      };
    };
    expect(toolsBody.result.tools.map((tool) => tool.name)).toEqual([
      "foundry.site.get",
      "foundry.content.list",
    ]);
    expect(toolsBody.result.nextCursor).toEqual(expect.any(String));
    const remainingTools = await runtime.fetch(
      rpcRequest(token, {
        jsonrpc: "2.0",
        id: 21,
        method: "tools/list",
        params: { cursor: toolsBody.result.nextCursor },
      }),
    );
    const remainingToolsBody = (await remainingTools.json()) as {
      result: {
        tools: Array<{ name: string }>;
        nextCursor: string | null;
      };
    };
    expect(remainingToolsBody.result).toEqual({
      tools: [expect.objectContaining({ name: "foundry.content.get" })],
    });
    expect(JSON.stringify(toolsBody)).not.toMatch(
      /subscriber|recipient|bulk.send|human.role/iu,
    );

    const schema = await runtime.fetch(
      rpcRequest(token, {
        jsonrpc: "2.0",
        id: 3,
        method: "resources/read",
        params: { uri: "foundry://schemas/content" },
      }),
    );
    await expect(schema.json()).resolves.toEqual(
      expect.objectContaining({
        result: {
          contents: [
            expect.objectContaining({
              mimeType: "application/schema+json",
              uri: "foundry://schemas/content",
            }),
          ],
        },
      }),
    );
  });

  it("does not consume an authorization code when the PKCE verifier is wrong", async () => {
    const { runtime } = fixture();
    const verifier = "v".repeat(64);
    const code = await authorize(runtime, verifier);

    async function exchange(codeVerifier: string) {
      return runtime.fetch(
        new Request(`${resourceUri}/oauth/token`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: clientId,
            redirect_uri: redirectUri,
            resource: resourceUri,
            code_verifier: codeVerifier,
          }),
        }),
      );
    }

    expect((await exchange("w".repeat(64))).status).toBe(400);
    expect((await exchange(verifier)).status).toBe(200);
  });

  it("returns structured tool results and stable execution errors", async () => {
    const { runtime } = fixture();
    const { accessToken: token } = await authorizeAndExchange(runtime);

    const list = await runtime.fetch(
      rpcRequest(token, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "foundry.content.list",
          arguments: { kind: null, limit: 20, cursor: null },
        },
      }),
    );
    await expect(list.json()).resolves.toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          isError: false,
          structuredContent: expect.objectContaining({
            contractVersion: "foundry.mcp.v1",
            result: expect.objectContaining({
              items: expect.any(Array),
            }),
          }),
        }),
      }),
    );

    const missing = await runtime.fetch(
      rpcRequest(token, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "foundry.content.get",
          arguments: { kind: "page", contentId: "other-site-canary" },
        },
      }),
    );
    const missingText = await missing.text();
    expect(JSON.parse(missingText)).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          isError: true,
          structuredContent: expect.objectContaining({
            error: expect.objectContaining({
              code: "OBJECT_NOT_FOUND",
              retryable: false,
            }),
          }),
        }),
      }),
    );
    expect(missingText).not.toContain("other-site-canary");
  });

  it("paginates resource discovery without repeating fixed resources", async () => {
    const { runtime } = fixture({ contentCount: 55 });
    const { accessToken } = await authorizeAndExchange(runtime);
    const first = await runtime.fetch(
      rpcRequest(accessToken, {
        jsonrpc: "2.0",
        id: 31,
        method: "resources/list",
        params: {},
      }),
    );
    const firstBody = (await first.json()) as {
      result: {
        resources: Array<{ uri: string }>;
        nextCursor: string | null;
      };
    };
    expect(firstBody.result.resources).toHaveLength(50);
    expect(firstBody.result.resources.map(({ uri }) => uri)).toContain(
      "foundry://schemas/design",
    );
    expect(firstBody.result.nextCursor).toEqual(expect.any(String));

    const second = await runtime.fetch(
      rpcRequest(accessToken, {
        jsonrpc: "2.0",
        id: 32,
        method: "resources/list",
        params: { cursor: firstBody.result.nextCursor },
      }),
    );
    const secondBody = (await second.json()) as {
      result: {
        resources: Array<{ uri: string }>;
        nextCursor: string | null;
      };
    };
    expect(secondBody.result.resources).toHaveLength(9);
    expect(secondBody.result.resources.map(({ uri }) => uri)).not.toContain(
      "foundry://site",
    );
    expect(secondBody.result).not.toHaveProperty("nextCursor");
  });

  it("conforms to MCP request, notification, ping, metadata, and protocol-version semantics", async () => {
    const { runtime } = fixture();
    const { accessToken } = await authorizeAndExchange(runtime);

    const notification = await runtime.fetch(
      rpcRequest(accessToken, {
        jsonrpc: "2.0",
        method: "notifications/unknown-client-event",
        params: { _meta: { "com.example/trace": "notification" } },
      }),
    );
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe("");

    const responseMessage = await runtime.fetch(
      rpcRequest(accessToken, {
        jsonrpc: "2.0",
        id: "server-request-1",
        result: {},
      }),
    );
    expect(responseMessage.status).toBe(202);
    expect(await responseMessage.text()).toBe("");

    const ping = await runtime.fetch(
      rpcRequest(accessToken, {
        jsonrpc: "2.0",
        id: "ping-1",
        method: "ping",
        params: { _meta: { "com.example/trace": "ping" } },
      }),
    );
    await expect(ping.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: "ping-1",
      result: {},
    });

    const tools = await runtime.fetch(
      rpcRequest(accessToken, {
        jsonrpc: "2.0",
        id: "tools-with-meta",
        method: "tools/list",
        params: { _meta: { "com.example/trace": "tools" } },
      }),
    );
    expect(tools.status).toBe(200);

    const noArguments = await runtime.fetch(
      rpcRequest(accessToken, {
        jsonrpc: "2.0",
        id: "site-without-arguments",
        method: "tools/call",
        params: {
          name: "foundry.site.get",
          _meta: { "com.example/trace": "call" },
        },
      }),
    );
    await expect(noArguments.json()).resolves.toEqual(
      expect.objectContaining({
        result: expect.objectContaining({ isError: false }),
      }),
    );

    const missingId = await runtime.fetch(
      rpcRequest(accessToken, {
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
      }),
    );
    expect(missingId.status).toBe(202);

    const nullId = await runtime.fetch(
      rpcRequest(accessToken, {
        jsonrpc: "2.0",
        id: null,
        method: "tools/list",
        params: {},
      }),
    );
    await expect(nullId.json()).resolves.toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: -32600 }),
      }),
    );

    const unsupported = rpcRequest(accessToken, {
      jsonrpc: "2.0",
      id: "unsupported-version",
      method: "ping",
    });
    unsupported.headers.set("mcp-protocol-version", "2099-01-01");
    const unsupportedResponse = await runtime.fetch(unsupported);
    expect(unsupportedResponse.status).toBe(400);

    const parseTemplate = rpcRequest(accessToken, {});
    const parseError = await runtime.fetch(
      new Request(resourceUri, {
        method: "POST",
        headers: parseTemplate.headers,
        body: "{",
      }),
    );
    await expect(parseError.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });

    const malformed = await runtime.fetch(
      rpcRequest(accessToken, {
        jsonrpc: "2.0",
        id: "malformed-request-id",
        method: "ping",
        unexpected: true,
      }),
    );
    await expect(malformed.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: "malformed-request-id",
      error: { code: -32600, message: "Invalid Request" },
    });
  });

  it("returns schema-conforming tool errors for invalid tool arguments", async () => {
    const { runtime, audit } = fixture();
    const { accessToken } = await authorizeAndExchange(runtime);

    const invalid = await runtime.fetch(
      rpcRequest(accessToken, {
        jsonrpc: "2.0",
        id: "invalid-tool-input",
        method: "tools/call",
        params: {
          name: "foundry.content.get",
          arguments: { kind: "page" },
        },
      }),
    );
    await expect(invalid.json()).resolves.toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          isError: true,
          structuredContent: expect.objectContaining({
            error: expect.objectContaining({
              code: "VALIDATION_FAILED",
            }),
          }),
        }),
      }),
    );
    expect(audit).toContainEqual(
      expect.objectContaining({
        operation: "foundry.content.get",
        outcome: "denied",
        reason: "VALIDATION_FAILED",
      }),
    );
  });

  it("validates advertised success and error structuredContent with an independent JSON Schema validator", async () => {
    const { runtime } = fixture();
    const { accessToken } = await authorizeAndExchange(runtime);
    const listed = await runtime.fetch(
      rpcRequest(accessToken, {
        jsonrpc: "2.0",
        id: "schema-list",
        method: "tools/list",
        params: {},
      }),
    );
    const listedBody = (await listed.json()) as {
      result: {
        tools: Array<{
          name: string;
          inputSchema: object;
          outputSchema: object;
        }>;
        nextCursor: string;
      };
    };
    const remaining = await runtime.fetch(
      rpcRequest(accessToken, {
        jsonrpc: "2.0",
        id: "schema-list-remaining",
        method: "tools/list",
        params: { cursor: listedBody.result.nextCursor },
      }),
    );
    const remainingBody = (await remaining.json()) as {
      result: {
        tools: Array<{
          name: string;
          inputSchema: object;
          outputSchema: object;
        }>;
      };
    };
    const descriptors = [
      ...listedBody.result.tools,
      ...remainingBody.result.tools,
    ];
    const ajv = new Ajv2020({
      strict: false,
      formats: {
        "date-time": true,
        uri: true,
      },
    });
    const validInputs = {
      "foundry.site.get": {},
      "foundry.content.list": { kind: null, limit: 10, cursor: null },
      "foundry.content.get": {
        kind: "page",
        contentId: referenceSiteDefinition.home.id,
      },
    } as const;
    for (const descriptor of descriptors) {
      const input =
        validInputs[descriptor.name as keyof typeof validInputs];
      const validateInput = ajv.compile(descriptor.inputSchema);
      expect(validateInput(input), descriptor.name).toBe(true);
      expect(validateInput({ ...input, unexpected: true }), descriptor.name)
        .toBe(false);

      const response = await runtime.fetch(
        rpcRequest(accessToken, {
          jsonrpc: "2.0",
          id: `schema-success:${descriptor.name}`,
          method: "tools/call",
          params: { name: descriptor.name, arguments: input },
        }),
      );
      const body = (await response.json()) as {
        result: { structuredContent: unknown };
      };
      const validateOutput = ajv.compile(descriptor.outputSchema);
      const validOutput = validateOutput(body.result.structuredContent);
      expect(
        validOutput,
        `${descriptor.name}: ${JSON.stringify(validateOutput.errors)}`,
      ).toBe(true);
    }

    const siteDescriptor = descriptors.find(
      ({ name }) => name === "foundry.site.get",
    )!;
    const invalidResponse = await runtime.fetch(
      rpcRequest(accessToken, {
        jsonrpc: "2.0",
        id: "schema-error",
        method: "tools/call",
        params: {
          name: siteDescriptor.name,
          arguments: { unexpected: true },
        },
      }),
    );
    const invalidBody = (await invalidResponse.json()) as {
      result: { structuredContent: unknown };
    };
    expect(
      ajv.compile(siteDescriptor.outputSchema)(
        invalidBody.result.structuredContent,
      ),
    ).toBe(true);
  });

  it("publishes honest lastModified annotations on every discovered resource", async () => {
    const { runtime } = fixture();
    const { accessToken } = await authorizeAndExchange(runtime);
    const response = await runtime.fetch(
      rpcRequest(accessToken, {
        jsonrpc: "2.0",
        id: "resource-metadata",
        method: "resources/list",
        params: {},
      }),
    );
    const body = (await response.json()) as {
      result: {
        resources: Array<{
          annotations?: { audience?: string[]; lastModified?: string };
        }>;
      };
    };
    expect(body.result.resources.length).toBeGreaterThan(0);
    for (const resource of body.result.resources) {
      expect(resource.annotations).toEqual({
        audience: ["user", "assistant"],
        lastModified: "2026-07-29T17:59:00.000Z",
      });
    }
  });

  it("rechecks D1 connection state so an unexpired token fails on the first post-revocation call", async () => {
    const { runtime, connections } = fixture();
    const { accessToken: token } = await authorizeAndExchange(runtime);
    const [connection] = [...connections.values()];
    connections.set(connection!.connectionId, {
      ...connection!,
      status: "revoked",
    });

    const response = await runtime.fetch(
      rpcRequest(token, {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/list",
        params: {},
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      "resource_metadata=",
    );
    await expect(response.json()).resolves.toEqual({
      error: "connection_revoked",
    });
  });

  it("lets the authenticated Owner revoke the immutable connection without erasing it", async () => {
    const { runtime, connections } = fixture();
    const { accessToken: token } = await authorizeAndExchange(runtime);
    const [connection] = [...connections.values()];

    const revoked = await runtime.fetch(
      new Request(
        `${canonicalOrigin}/api/foundry-cms/mcp-connections/revoke`,
        {
          method: "POST",
          headers: {
            origin: canonicalOrigin,
            "content-type": "application/json",
            "x-foundry-csrf": "verified-by-owner-boundary",
          },
          body: JSON.stringify({
            connectionId: connection!.connectionId,
            reason: "Owner ended the test connection.",
          }),
        },
      ),
    );
    expect(revoked.status).toBe(204);
    expect(connections.get(connection!.connectionId)).toEqual(
      expect.objectContaining({
        actorId: connection!.actorId,
        status: "revoked",
      }),
    );
    expect(
      (
        await runtime.fetch(
          rpcRequest(token, {
            jsonrpc: "2.0",
            id: 8,
            method: "tools/list",
            params: {},
          }),
        )
      ).status,
    ).toBe(401);
  });

  it("rotates refresh tokens and revokes the connection when an old token is reused", async () => {
    const { runtime, connections } = fixture();
    const first = await authorizeAndExchange(runtime);

    async function refresh(refreshToken: string) {
      return runtime.fetch(
        new Request(`${resourceUri}/oauth/token`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: clientId,
            resource: resourceUri,
          }),
        }),
      );
    }

    const rotated = await refresh(first.refreshToken);
    expect(rotated.status).toBe(200);
    const rotatedBody = (await rotated.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(rotatedBody.refresh_token).not.toBe(first.refreshToken);

    const reuse = await refresh(first.refreshToken);
    expect(reuse.status).toBe(400);
    await expect(reuse.json()).resolves.toEqual({
      error: "invalid_grant",
    });
    expect([...connections.values()][0]).toEqual(
      expect.objectContaining({ status: "revoked" }),
    );
    expect(
      (
        await runtime.fetch(
          rpcRequest(rotatedBody.access_token, {
            jsonrpc: "2.0",
            id: 10,
            method: "tools/list",
            params: {},
          }),
        )
      ).status,
    ).toBe(401);
  });

  it.each([
    ["foreign Origin", { origin: "https://attacker.example" }],
    ["token in query", { queryToken: true }],
  ])("fails closed for %s", async (_label, attempt) => {
    const { runtime } = fixture();
    const { accessToken: token } = await authorizeAndExchange(runtime);
    const queryToken = "queryToken" in attempt && attempt.queryToken === true;
    const url = queryToken
      ? `${resourceUri}?access_token=${encodeURIComponent(token)}`
      : resourceUri;
    const request = rpcRequest(token, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/list",
      params: {},
    });
    const headers = new Headers(request.headers);
    if ("origin" in attempt) headers.set("origin", attempt.origin);
    if (queryToken) headers.delete("authorization");
    const response = await runtime.fetch(
      new Request(url, {
        method: "POST",
        headers,
        body: await request.text(),
      }),
    );
    expect(response.status).toBe(queryToken ? 401 : 403);
  });

  it.each([
    ["foreign audience", { audience: "https://other.example/api/foundry-mcp" }],
    ["human identity", { subject: "membership-owner" }],
    ["foreign site", { siteId: "site_other" }],
  ])("rejects a correctly signed token with %s", async (_label, overrides) => {
    const { runtime, connections } = fixture();
    await authorizeAndExchange(runtime);
    const [connection] = [...connections.values()];
    const response = await runtime.fetch(
      rpcRequest(
        await forgedToken({
          connectionId: connection!.connectionId,
          actorId: connection!.actorId,
          ...overrides,
        }),
        {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/list",
        params: {},
        },
      ),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      "scope=\"site.read\"",
    );
  });

  it("bounds request size, nesting, and durable request budgets", async () => {
    const ordinary = fixture();
    const { accessToken } = await authorizeAndExchange(ordinary.runtime);
    const oversized = await ordinary.runtime.fetch(
      new Request(resourceUri, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          origin: canonicalOrigin,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({ payload: "x".repeat(300_000) }),
      }),
    );
    expect(oversized.status).toBe(413);
    expect(ordinary.rateLimitInputs.map(({ bucketKey }) => bucketKey)).toEqual([
      "site",
      "11111111-1111-4111-8111-111111111111",
    ]);

    let nested: unknown = "leaf";
    for (let index = 0; index < 40; index += 1) {
      nested = { nested };
    }
    const tooDeep = await ordinary.runtime.fetch(
      rpcRequest(accessToken, {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/list",
        params: nested,
      }),
    );
    await expect(tooDeep.json()).resolves.toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: -32602 }),
      }),
    );

    const limited = fixture({ allowRateLimit: (call) => call < 3 });
    const limitedToken = await authorizeAndExchange(limited.runtime);
    const rateLimited = await limited.runtime.fetch(
      rpcRequest(limitedToken.accessToken, {
        jsonrpc: "2.0",
        id: 12,
        method: "tools/list",
        params: {},
      }),
    );
    expect(rateLimited.status).toBe(429);
    expect(Number(rateLimited.headers.get("retry-after"))).toBeGreaterThan(0);
    await expect(rateLimited.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: 12,
      error: {
        code: -32003,
        message: "Rate limited",
        data: {
          code: "RATE_LIMITED",
          retryAfterMs: expect.any(Number),
        },
      },
    });

    const ingressLimited = fixture({ allowRateLimit: false });
    const ingressToken = await authorizeAndExchange(ingressLimited.runtime);
    const ingressResponse = await ingressLimited.runtime.fetch(
      rpcRequest(ingressToken.accessToken, {
        jsonrpc: "2.0",
        id: "ingress-rate-limit",
        method: "tools/list",
        params: {},
      }),
    );
    expect(ingressResponse.status).toBe(429);
    await expect(ingressResponse.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: "ingress-rate-limit",
      error: {
        code: -32003,
        message: "Rate limited",
        data: {
          code: "RATE_LIMITED",
          retryAfterMs: expect.any(Number),
        },
      },
    });
  });

  it.each([
    [
      "foreign Origin",
      {
        origin: "https://attacker.example",
        accept: "application/json, text/event-stream",
        contentType: "application/json",
        protocolVersion: "2025-11-25",
      },
    ],
    [
      "unsupported media",
      {
        origin: canonicalOrigin,
        accept: "application/json",
        contentType: "text/plain",
        protocolVersion: "2025-11-25",
      },
    ],
    [
      "unsupported protocol",
      {
        origin: canonicalOrigin,
        accept: "application/json, text/event-stream",
        contentType: "application/json",
        protocolVersion: "2099-01-01",
      },
    ],
  ])(
    "rejects %s before authentication or ingress accounting",
    async (_label, headers) => {
      const state = fixture();
      const { accessToken } = await authorizeAndExchange(state.runtime);
      const lookupsBeforeRequest = state.connectionLookupInputs.length;
      const response = await state.runtime.fetch(
        new Request(resourceUri, {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            origin: headers.origin,
            accept: headers.accept,
            "content-type": headers.contentType,
            "mcp-protocol-version": headers.protocolVersion,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "guard-order",
            method: "tools/list",
            params: {},
          }),
        }),
      );

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(state.connectionLookupInputs).toHaveLength(lookupsBeforeRequest);
      expect(state.rateLimitInputs).toEqual([]);
    },
  );

  it("keeps timeout correlation and prevents downstream audit after expiry", async () => {
    let releaseApplicationLookup: (() => void) | undefined;
    const stalled = new Promise<void>((resolve) => {
      releaseApplicationLookup = resolve;
    });
    const state = fixture({
      requestTimeoutMs: 10,
      beforeFindCurrentConnection: async (call) => {
        if (call === 2) await stalled;
      },
    });
    const { accessToken } = await authorizeAndExchange(state.runtime);
    const response = await state.runtime.fetch(
      rpcRequest(accessToken, {
        jsonrpc: "2.0",
        id: "deadline-1",
        method: "resources/read",
        params: { uri: "foundry://site" },
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: "deadline-1",
      error: {
        code: -32001,
        message: "Request deadline exceeded",
        data: { code: "TEMPORARILY_UNAVAILABLE" },
      },
    });

    releaseApplicationLookup?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.audit).toEqual([]);
  });

  it("reports authentication dependency expiry as temporary unavailability", async () => {
    let releaseAuthenticationLookup: (() => void) | undefined;
    const stalled = new Promise<void>((resolve) => {
      releaseAuthenticationLookup = resolve;
    });
    const state = fixture({
      requestTimeoutMs: 10,
      beforeFindCurrentConnection: async (call) => {
        if (call === 1) await stalled;
      },
    });
    const { accessToken } = await authorizeAndExchange(state.runtime);
    const response = await state.runtime.fetch(
      rpcRequest(accessToken, {
        jsonrpc: "2.0",
        id: "authentication-deadline",
        method: "tools/list",
        params: {},
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "temporarily_unavailable",
    });
    expect(state.rateLimitInputs).toEqual([]);

    releaseAuthenticationLookup?.();

    const unavailable = fixture({
      beforeFindCurrentConnection: async () => {
        throw new Error("D1 unavailable");
      },
    });
    const unavailableToken = await authorizeAndExchange(unavailable.runtime);
    const unavailableResponse = await unavailable.runtime.fetch(
      rpcRequest(unavailableToken.accessToken, {
        jsonrpc: "2.0",
        id: "authentication-dependency",
        method: "tools/list",
        params: {},
      }),
    );
    expect(unavailableResponse.status).toBe(503);
    await expect(unavailableResponse.json()).resolves.toEqual({
      error: "temporarily_unavailable",
    });
    expect(unavailable.rateLimitInputs).toEqual([]);
  });

  it("settles an in-flight audit before releasing a deadline response", async () => {
    let releaseAudit: (() => void) | undefined;
    const stalledAudit = new Promise<void>((resolve) => {
      releaseAudit = resolve;
    });
    const state = fixture({
      requestTimeoutMs: 10,
      beforeRecordInvocation: async () => stalledAudit,
    });
    const { accessToken } = await authorizeAndExchange(state.runtime);
    let responseSettled = false;
    const pendingResponse = state.runtime
      .fetch(
        rpcRequest(accessToken, {
          jsonrpc: "2.0",
          id: "audit-deadline",
          method: "resources/read",
          params: { uri: "foundry://site" },
        }),
      )
      .then((response) => {
        responseSettled = true;
        return response;
      });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(responseSettled).toBe(false);
    expect(state.audit).toEqual([]);

    releaseAudit?.();
    const response = await pendingResponse;
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: "audit-deadline",
      error: {
        code: -32001,
        message: "Request deadline exceeded",
        data: { code: "TEMPORARILY_UNAVAILABLE" },
      },
    });
    expect(state.audit).toHaveLength(1);
  });

  it("correlates malformed resource URIs and unexpected post-parse failures", async () => {
    const malformed = fixture();
    const { accessToken } = await authorizeAndExchange(malformed.runtime);
    const malformedResponse = await malformed.runtime.fetch(
      rpcRequest(accessToken, {
        jsonrpc: "2.0",
        id: "malformed-uri",
        method: "resources/read",
        params: { uri: "foundry://content/post/%" },
      }),
    );
    await expect(malformedResponse.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: "malformed-uri",
      error: {
        code: -32602,
        message: "Invalid resource request",
      },
    });

    const unexpected = fixture({
      beforeConsumeRateLimit: async (call) => {
        if (call === 3) throw new Error("dependency exploded");
      },
    });
    const unexpectedToken = await authorizeAndExchange(unexpected.runtime);
    const unexpectedResponse = await unexpected.runtime.fetch(
      rpcRequest(unexpectedToken.accessToken, {
        jsonrpc: "2.0",
        id: 202,
        method: "tools/list",
        params: {},
      }),
    );
    expect(unexpectedResponse.status).toBe(500);
    await expect(unexpectedResponse.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: 202,
      error: {
        code: -32603,
        message: "Internal error",
      },
    });
  });

  it("normalizes adversarial method names into bounded durable rate keys", async () => {
    const state = fixture();
    const { accessToken } = await authorizeAndExchange(state.runtime);
    await state.runtime.fetch(
      rpcRequest(accessToken, {
        jsonrpc: "2.0",
        id: "unknown-method",
        method: `unknown/${"x".repeat(200_000)}`,
        params: {},
      }),
    );
    expect(state.rateLimitInputs.length).toBeGreaterThan(0);
    expect(
      Math.max(...state.rateLimitInputs.map(({ bucketKey }) => bucketKey.length)),
    ).toBeLessThanOrEqual(128);
    expect(state.rateLimitInputs.some(({ bucketKey }) =>
      bucketKey.endsWith(":unknown"),
    )).toBe(true);
  });
});
