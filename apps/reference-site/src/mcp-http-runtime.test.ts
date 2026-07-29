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
import { referenceSiteDefinition } from "@foundry/site-definition";

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

function createStore() {
  const connections = new Map<string, McpConnectionGrant>();
  const codes = new Map<
    string,
    McpAuthorizationGrantInput & { consumed: boolean }
  >();
  const audit: McpReadAuditEvent[] = [];
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
    async recordInvocation(event) {
      audit.push(event);
    },
  };
  return { store, connections, audit };
}

function fixture() {
  const state = createStore();
  const cursors = createSignedMcpCursorCodec({
    secret: signingSecret,
    now: () => now,
  });
  const readApplication = createMcpReadApplication({
    site: createSiteApplication({
      siteId: referenceSiteDefinition.site.id,
      publishedSites: createInMemoryPublishedSiteRepository([
        createPublishedSiteBundle(referenceSiteDefinition),
      ]),
    }),
    siteMetadata: {
      canonicalUrl: canonicalOrigin,
      locale: "en-CA",
      timeZone: "America/Vancouver",
    },
    connections: state.store,
    cursors,
    createInvocationId: () => crypto.randomUUID(),
    now: () => now.toISOString(),
  });
  let nextId = 0;
  const runtime = createMcpHttpRuntime({
    resourceUri,
    authorizationIssuer: canonicalOrigin,
    canonicalOrigin,
    signingSecret,
    siteId: referenceSiteDefinition.site.id,
    siteName: referenceSiteDefinition.site.name,
    store: state.store,
    readApplication,
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
    createOpaqueValue: () => `opaque-${++nextId}`,
    now: () => now,
  });
  return { runtime, ...state };
}

async function authorizeAndExchange(
  runtime: ReturnType<typeof createMcpHttpRuntime>,
) {
  const verifier = "v".repeat(64);
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

  const token = await runtime.fetch(
    new Request(`${resourceUri}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: redirected.searchParams.get("code")!,
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
    scope: string;
    token_type: string;
  };
  expect(body).toEqual(
    expect.objectContaining({
      access_token: expect.any(String),
      scope: "site.read",
      token_type: "Bearer",
    }),
  );
  return body.access_token;
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
    const token = await authorizeAndExchange(runtime);

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
      result: { tools: Array<{ name: string; inputSchema: unknown }> };
    };
    expect(toolsBody.result.tools.map((tool) => tool.name)).toEqual([
      "foundry.site.get",
      "foundry.content.list",
      "foundry.content.get",
    ]);
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

  it("returns structured tool results and stable execution errors", async () => {
    const { runtime } = fixture();
    const token = await authorizeAndExchange(runtime);

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

  it("rechecks D1 connection state so an unexpired token fails on the first post-revocation call", async () => {
    const { runtime, connections } = fixture();
    const token = await authorizeAndExchange(runtime);
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
    const token = await authorizeAndExchange(runtime);
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

  it.each([
    ["foreign Origin", { origin: "https://attacker.example" }],
    ["token in query", { queryToken: true }],
  ])("fails closed for %s", async (_label, attempt) => {
    const { runtime } = fixture();
    const token = await authorizeAndExchange(runtime);
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
});
