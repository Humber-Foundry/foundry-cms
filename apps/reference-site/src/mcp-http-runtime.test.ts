import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";

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

function createStore(allowRateLimit = true) {
  const connections = new Map<string, McpConnectionGrant>();
  const codes = new Map<
    string,
    McpAuthorizationGrantInput & { consumed: boolean }
  >();
  const audit: McpReadAuditEvent[] = [];
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
    async consumeAuthorizationCode(input) {
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
      return {
        ...connections.get(code.connectionId)!,
        codeChallenge: code.codeChallenge,
      };
    },
    async findCurrentConnection(input) {
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
    async saveRefreshToken(input) {
      refreshTokens.set(input.tokenHash, {
        familyId: input.familyId,
        connectionId: input.connectionId,
        clientId: input.clientId,
        consumed: false,
        revoked: false,
      });
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
    async consumeRateLimit() {
      return allowRateLimit;
    },
    async recordInvocation(event) {
      audit.push(event);
    },
  };
  return { store, connections, audit };
}

function fixture(
  options: { allowRateLimit?: boolean; contentCount?: number } = {},
) {
  const state = createStore(options.allowRateLimit ?? true);
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
      nextCursor: null,
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
    expect(secondBody.result.nextCursor).toBeNull();
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

    const limited = fixture({ allowRateLimit: false });
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
  });
});
