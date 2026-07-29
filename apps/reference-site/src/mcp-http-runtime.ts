import { SignJWT, jwtVerify } from "jose";

import {
  McpReadError,
  mcpContractVersion,
  mcpInitialScope,
  type McpConnectionGrant,
  type McpConnectionPrincipal,
  type McpConnectionStore,
  type McpCursorBinding,
  type McpCursorCodec,
  type createMcpReadApplication,
} from "@foundry/application";
import {
  siteDefinitionSchema,
  type SiteId,
} from "@foundry/site-definition";

import type { ConsumedMcpAuthorizationCode } from "./d1-mcp-connection-store";

const protocolVersion = "2025-11-25";
const accessTokenLifetimeSeconds = 5 * 60;
const authorizationCodeLifetimeSeconds = 5 * 60;
const cursorLifetimeSeconds = 15 * 60;

export type McpAuthorizationGrantInput = Readonly<{
  connectionId: string;
  actorId: string;
  siteId: SiteId;
  clientId: string;
  redirectUri: string;
  ownerMembershipId: string;
  codeHash: string;
  codeChallenge: string;
  expiresAt: string;
  now: string;
}>;

export type McpAuthorizationRuntimeStore = McpConnectionStore &
  Readonly<{
    createAuthorizationGrant(input: McpAuthorizationGrantInput): Promise<void>;
    consumeAuthorizationCode(input: {
      codeHash: string;
      clientId: string;
      redirectUri: string;
      now: string;
    }): Promise<ConsumedMcpAuthorizationCode | null>;
    revokeConnection(input: {
      siteId: SiteId;
      connectionId: string;
      ownerMembershipId: string;
      now: string;
    }): Promise<boolean>;
  }>;

type McpReadApplication = ReturnType<typeof createMcpReadApplication>;
type OwnerAuthenticationIntent = Readonly<{
  mode: "view" | "mutate";
  csrfToken: string | null;
}>;

type RpcRequest = Readonly<{
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}>;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: JsonRecord,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string> = [],
) {
  const keys = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

async function hmacKey(secret: string) {
  if (secret.length < 32) {
    throw new TypeError("mcp_signing_secret_invalid");
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export function createSignedMcpCursorCodec({
  secret,
  now = () => new Date(),
}: {
  secret: string;
  now?: () => Date;
}): McpCursorCodec {
  return {
    async encode(binding) {
      const payload = base64UrlEncode(
        new TextEncoder().encode(
          JSON.stringify({
            ...binding,
            expiresAt:
              Math.floor(now().getTime() / 1_000) + cursorLifetimeSeconds,
          }),
        ),
      );
      const signature = await crypto.subtle.sign(
        "HMAC",
        await hmacKey(secret),
        new TextEncoder().encode(payload),
      );
      return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
    },
    async decode(cursor) {
      const [payload, signature, unexpected] = cursor.split(".");
      if (
        payload === undefined ||
        signature === undefined ||
        unexpected !== undefined
      ) {
        throw new TypeError("mcp_cursor_invalid");
      }
      const verified = await crypto.subtle.verify(
        "HMAC",
        await hmacKey(secret),
        base64UrlDecode(signature).buffer as ArrayBuffer,
        new TextEncoder().encode(payload),
      );
      const decoded: unknown = JSON.parse(
        new TextDecoder().decode(base64UrlDecode(payload)),
      );
      if (
        !verified ||
        !isRecord(decoded) ||
        typeof decoded.siteId !== "string" ||
        typeof decoded.actorId !== "string" ||
        typeof decoded.query !== "string" ||
        typeof decoded.offset !== "number" ||
        typeof decoded.expiresAt !== "number" ||
        decoded.expiresAt < Math.floor(now().getTime() / 1_000)
      ) {
        throw new TypeError("mcp_cursor_invalid");
      }
      return {
        siteId: decoded.siteId as SiteId,
        actorId: decoded.actorId,
        query: decoded.query,
        offset: decoded.offset,
      } satisfies McpCursorBinding;
    },
  };
}

function jsonResponse(
  value: unknown,
  status = 200,
  headers: HeadersInit = {},
) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function rpcResult(id: RpcRequest["id"], result: unknown) {
  return jsonResponse({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(
  id: RpcRequest["id"],
  code: number,
  message: string,
  data?: unknown,
) {
  return jsonResponse({
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  });
}

function safeErrorMessage(code: McpReadError["code"]) {
  const messages = {
    AUTHENTICATION_REQUIRED: "Authentication is required.",
    INSUFFICIENT_SCOPE: "The connection lacks the required permission.",
    CONNECTION_REVOKED: "The MCP connection has been revoked.",
    OBJECT_NOT_FOUND: "The requested object was not found.",
    VALIDATION_FAILED: "The request is invalid.",
    TEMPORARILY_UNAVAILABLE: "The service is temporarily unavailable.",
  } as const;
  return messages[code];
}

function toolResult(
  structuredContent: unknown,
  isError: boolean,
) {
  return {
    isError,
    structuredContent,
    content: [
      {
        type: "text",
        text: JSON.stringify(structuredContent),
      },
    ],
  };
}

function successOutputSchema(result: unknown) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      contractVersion: { const: mcpContractVersion },
      invocationId: { type: "string", minLength: 1 },
      result,
      meta: {
        type: "object",
        additionalProperties: false,
        properties: {
          replayed: { const: false },
          observedAt: { type: "string", format: "date-time" },
        },
        required: ["replayed", "observedAt"],
      },
    },
    required: ["contractVersion", "invocationId", "result", "meta"],
    $defs: siteDefinitionSchema.$defs,
  };
}

const toolCatalog = [
  {
    name: "foundry.site.get",
    description: "Read this connection's site metadata.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    outputSchema: successOutputSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        siteId: { type: "string" },
        displayName: { type: "string" },
        canonicalUrl: { type: "string", format: "uri" },
        locale: { type: "string" },
        timeZone: { type: "string" },
        schemaVersion: { type: "string" },
      },
      required: [
        "siteId",
        "displayName",
        "canonicalUrl",
        "locale",
        "timeZone",
        "schemaVersion",
      ],
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    execution: { taskSupport: "forbidden" },
  },
  {
    name: "foundry.content.list",
    description: "List published page and post documents with bounded pagination.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { anyOf: [{ enum: ["page", "post"] }, { type: "null" }] },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["kind", "limit", "cursor"],
    },
    outputSchema: successOutputSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { enum: ["page", "post"] },
              contentId: { type: "string" },
              title: { type: "string" },
              revision: { type: "integer", minimum: 0 },
            },
            required: ["kind", "contentId", "title", "revision"],
          },
        },
        nextCursor: {
          anyOf: [{ type: "string" }, { type: "null" }],
        },
      },
      required: ["items", "nextCursor"],
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    execution: { taskSupport: "forbidden" },
  },
  {
    name: "foundry.content.get",
    description: "Read one published page or post document.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { enum: ["page", "post"] },
        contentId: { type: "string", minLength: 1, maxLength: 200 },
      },
      required: ["kind", "contentId"],
    },
    outputSchema: successOutputSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { enum: ["page", "post"] },
        contentId: { type: "string" },
        revision: { type: "integer", minimum: 0 },
        document: {
          oneOf: [
            siteDefinitionSchema.properties.home,
            siteDefinitionSchema.$defs.blogPost,
          ],
        },
      },
      required: ["kind", "contentId", "revision", "document"],
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    execution: { taskSupport: "forbidden" },
  },
] as const;

function protectedResourceMetadataPath(resourceUri: string) {
  const resource = new URL(resourceUri);
  return `/.well-known/oauth-protected-resource${resource.pathname}`;
}

export function createMcpHttpRuntime({
  resourceUri,
  authorizationIssuer,
  canonicalOrigin,
  signingSecret,
  siteId,
  siteName,
  store,
  readApplication,
  registeredClients,
  authenticateOwner,
  authorizationPath = `${new URL(resourceUri).pathname}/oauth/authorize`,
  ownerRevocationPath = "/api/foundry-cms/mcp-connections/revoke",
  createOpaqueValue = () => crypto.randomUUID(),
  now = () => new Date(),
}: {
  resourceUri: string;
  authorizationIssuer: string;
  canonicalOrigin: string;
  signingSecret: string;
  siteId: SiteId;
  siteName: string;
  store: McpAuthorizationRuntimeStore;
  readApplication: McpReadApplication;
  registeredClients: Readonly<
    Record<
      string,
      Readonly<{ name: string; redirectUris: ReadonlyArray<string> }>
    >
  >;
  authenticateOwner(
    request: Request,
    intent: OwnerAuthenticationIntent,
  ): Promise<{ membershipId: string; csrfToken?: string }>;
  authorizationPath?: string;
  ownerRevocationPath?: string;
  createOpaqueValue?: () => string;
  now?: () => Date;
}) {
  const resource = new URL(resourceUri);
  if (
    resource.protocol !== "https:" ||
    resource.origin !== canonicalOrigin ||
    new URL(authorizationIssuer).protocol !== "https:"
  ) {
    throw new TypeError("mcp_production_origin_invalid");
  }
  const metadataUri = `${canonicalOrigin}${protectedResourceMetadataPath(resourceUri)}`;
  const challengeHeader =
    `Bearer resource_metadata="${metadataUri}", scope="${mcpInitialScope}"`;
  const signingKey = new TextEncoder().encode(signingSecret);

  function authenticationFailure(error = "invalid_token") {
    return jsonResponse(
      { error },
      401,
      { "www-authenticate": challengeHeader },
    );
  }

  async function authenticateMcpRequest(
    request: Request,
  ): Promise<McpConnectionPrincipal | Response> {
    const authorization = request.headers.get("authorization");
    if (
      authorization === null ||
      !authorization.startsWith("Bearer ") ||
      new URL(request.url).searchParams.has("access_token")
    ) {
      return authenticationFailure();
    }
    try {
      const { payload, protectedHeader } = await jwtVerify(
        authorization.slice("Bearer ".length),
        signingKey,
        {
          algorithms: ["HS256"],
          issuer: authorizationIssuer,
          audience: resourceUri,
          clockTolerance: 5,
          currentDate: now(),
        },
      );
      if (
        protectedHeader.alg !== "HS256" ||
        payload.resource !== resourceUri ||
        payload.token_type !== "access_token" ||
        typeof payload.sub !== "string" ||
        typeof payload.connection_id !== "string" ||
        typeof payload.client_id !== "string" ||
        payload.site_id !== siteId ||
        payload.scope !== mcpInitialScope
      ) {
        return authenticationFailure();
      }
      const principal: McpConnectionPrincipal = {
        connectionId: payload.connection_id,
        actorId: payload.sub,
        clientId: payload.client_id,
        siteId,
        scopes: [mcpInitialScope],
      };
      const current = await store.findCurrentConnection({
        connectionId: principal.connectionId,
        siteId,
      });
      if (
        current === null ||
        current.status !== "active" ||
        current.actorId !== principal.actorId ||
        current.clientId !== principal.clientId ||
        current.siteId !== principal.siteId ||
        current.scopes.length !== 1 ||
        current.scopes[0] !== mcpInitialScope
      ) {
        return authenticationFailure(
          current?.status === "revoked"
            ? "connection_revoked"
            : "invalid_token",
        );
      }
      return principal;
    } catch {
      return authenticationFailure();
    }
  }

  function readAuthorizationRequest(body: unknown) {
    if (
      !isRecord(body) ||
      !hasExactKeys(body, [
        "response_type",
        "client_id",
        "redirect_uri",
        "resource",
        "scope",
        "state",
        "code_challenge",
        "code_challenge_method",
      ]) ||
      body.response_type !== "code" ||
      typeof body.client_id !== "string" ||
      typeof body.redirect_uri !== "string" ||
      body.resource !== resourceUri ||
      body.scope !== mcpInitialScope ||
      typeof body.state !== "string" ||
      body.state.length < 8 ||
      typeof body.code_challenge !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(body.code_challenge) ||
      body.code_challenge_method !== "S256"
    ) {
      return null;
    }
    const client = registeredClients[body.client_id];
    if (
      client === undefined ||
      !client.redirectUris.includes(body.redirect_uri)
    ) {
      return null;
    }
    return {
      responseType: body.response_type,
      clientId: body.client_id,
      clientName: client.name,
      redirectUri: body.redirect_uri,
      resource: body.resource,
      scope: body.scope,
      state: body.state,
      codeChallenge: body.code_challenge,
      codeChallengeMethod: body.code_challenge_method,
    };
  }

  async function handleAuthorization(request: Request) {
    if (request.method === "GET") {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      const authorization = readAuthorizationRequest(query);
      if (authorization === null) {
        return jsonResponse({ error: "invalid_request" }, 400);
      }
      let owner;
      try {
        owner = await authenticateOwner(request, {
          mode: "view",
          csrfToken: null,
        });
      } catch {
        return jsonResponse({ error: "access_denied" }, 403);
      }
      if (owner.csrfToken === undefined) {
        return jsonResponse({ error: "access_denied" }, 403);
      }
      const hidden = {
        response_type: authorization.responseType,
        client_id: authorization.clientId,
        redirect_uri: authorization.redirectUri,
        resource: authorization.resource,
        scope: authorization.scope,
        state: authorization.state,
        code_challenge: authorization.codeChallenge,
        code_challenge_method: authorization.codeChallengeMethod,
        csrf_token: owner.csrfToken,
      };
      const fields = Object.entries(hidden)
        .map(
          ([name, value]) =>
            `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
        )
        .join("\n");
      return new Response(
        `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Connect MCP client</title></head>
  <body>
    <main>
      <h1>Connect ${escapeHtml(authorization.clientName)}</h1>
      <p>Grant read-only access to ${escapeHtml(siteName)}.</p>
      <dl><dt>Permission</dt><dd>Read published site content and schema (site.read)</dd></dl>
      <form method="post" action="${escapeHtml(authorizationPath)}">
        ${fields}
        <button type="submit">Approve read-only connection</button>
      </form>
    </main>
  </body>
</html>`,
        {
          status: 200,
          headers: {
            "cache-control": "no-store",
            "content-security-policy":
              "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
            "content-type": "text/html; charset=utf-8",
            "x-content-type-options": "nosniff",
          },
        },
      );
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405, {
        allow: "GET, POST",
      });
    }
    if (request.headers.get("origin") !== canonicalOrigin) {
      return jsonResponse({ error: "invalid_request" }, 400);
    }
    const contentType = request.headers.get("content-type")?.toLowerCase();
    let body: unknown;
    let csrfToken: string | null = null;
    try {
      if (contentType?.startsWith("application/json") === true) {
        body = await request.json();
      } else if (
        contentType?.startsWith("application/x-www-form-urlencoded") === true
      ) {
        const form = new URLSearchParams(await request.text());
        csrfToken = form.get("csrf_token");
        form.delete("csrf_token");
        body = Object.fromEntries(form);
      } else {
        return jsonResponse({ error: "invalid_request" }, 400);
      }
    } catch {
      return jsonResponse({ error: "invalid_request" }, 400);
    }
    const authorization = readAuthorizationRequest(body);
    if (authorization === null) {
      return jsonResponse({ error: "invalid_request" }, 400);
    }
    let owner;
    try {
      owner = await authenticateOwner(request, {
        mode: "mutate",
        csrfToken,
      });
    } catch {
      return jsonResponse({ error: "access_denied" }, 403);
    }
    const code = createOpaqueValue();
    const connectionId = `connection-${createOpaqueValue()}`;
    const actorId = `mcp-${createOpaqueValue()}`;
    const observedAt = now();
    await store.createAuthorizationGrant({
      connectionId,
      actorId,
      siteId,
      clientId: authorization.clientId,
      redirectUri: authorization.redirectUri,
      ownerMembershipId: owner.membershipId,
      codeHash: await sha256(code),
      codeChallenge: authorization.codeChallenge,
      expiresAt: new Date(
        observedAt.getTime() + authorizationCodeLifetimeSeconds * 1_000,
      ).toISOString(),
      now: observedAt.toISOString(),
    });
    const redirect = new URL(authorization.redirectUri);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", authorization.state);
    return new Response(null, {
      status: 303,
      headers: {
        "cache-control": "no-store",
        location: redirect.toString(),
      },
    });
  }

  async function handleToken(request: Request) {
    if (
      request.method !== "POST" ||
      request.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("application/x-www-form-urlencoded") !== true
    ) {
      return jsonResponse({ error: "invalid_request" }, 400);
    }
    const form = new URLSearchParams(await request.text());
    const code = form.get("code");
    const clientId = form.get("client_id");
    const redirectUri = form.get("redirect_uri");
    const verifier = form.get("code_verifier");
    if (
      form.get("grant_type") !== "authorization_code" ||
      form.get("resource") !== resourceUri ||
      code === null ||
      clientId === null ||
      redirectUri === null ||
      verifier === null ||
      !/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)
    ) {
      return jsonResponse({ error: "invalid_grant" }, 400);
    }
    const exchanged = await store.consumeAuthorizationCode({
      codeHash: await sha256(code),
      clientId,
      redirectUri,
      now: now().toISOString(),
    });
    if (
      exchanged === null ||
      exchanged.siteId !== siteId ||
      exchanged.scopes.length !== 1 ||
      exchanged.scopes[0] !== mcpInitialScope ||
      (await sha256(verifier)) !== exchanged.codeChallenge
    ) {
      return jsonResponse({ error: "invalid_grant" }, 400);
    }
    const issuedAt = Math.floor(now().getTime() / 1_000);
    const accessToken = await new SignJWT({
      resource: resourceUri,
      token_type: "access_token",
      connection_id: exchanged.connectionId,
      client_id: exchanged.clientId,
      site_id: siteId,
      scope: mcpInitialScope,
    })
      .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
      .setIssuer(authorizationIssuer)
      .setAudience(resourceUri)
      .setSubject(exchanged.actorId)
      .setIssuedAt(issuedAt)
      .setNotBefore(issuedAt)
      .setExpirationTime(issuedAt + accessTokenLifetimeSeconds)
      .setJti(createOpaqueValue())
      .sign(signingKey);
    return jsonResponse({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: accessTokenLifetimeSeconds,
      scope: mcpInitialScope,
      resource: resourceUri,
    });
  }

  async function callTool(
    principal: McpConnectionPrincipal,
    name: unknown,
    argumentsValue: unknown,
  ) {
    try {
      if (!isRecord(argumentsValue)) {
        return null;
      }
      if (
        name === "foundry.site.get" &&
        hasExactKeys(argumentsValue, [])
      ) {
        return toolResult(await readApplication.getSite(principal), false);
      }
      if (
        name === "foundry.content.list" &&
        hasExactKeys(argumentsValue, ["kind", "limit", "cursor"]) &&
        (argumentsValue.kind === null ||
          argumentsValue.kind === "page" ||
          argumentsValue.kind === "post") &&
        typeof argumentsValue.limit === "number" &&
        (argumentsValue.cursor === null ||
          typeof argumentsValue.cursor === "string")
      ) {
        return toolResult(
          await readApplication.listContent(principal, {
            kind: argumentsValue.kind,
            limit: argumentsValue.limit,
            cursor: argumentsValue.cursor,
          }),
          false,
        );
      }
      if (
        name === "foundry.content.get" &&
        hasExactKeys(argumentsValue, ["kind", "contentId"]) &&
        (argumentsValue.kind === "page" ||
          argumentsValue.kind === "post") &&
        typeof argumentsValue.contentId === "string" &&
        argumentsValue.contentId.length >= 1 &&
        argumentsValue.contentId.length <= 200
      ) {
        return toolResult(
          await readApplication.getContent(principal, {
            kind: argumentsValue.kind,
            contentId: argumentsValue.contentId,
          }),
          false,
        );
      }
      return null;
    } catch (error) {
      if (!(error instanceof McpReadError)) throw error;
      const observedAt = error.observedAt ?? now().toISOString();
      return toolResult(
        {
          contractVersion: mcpContractVersion,
          invocationId: error.invocationId ?? crypto.randomUUID(),
          error: {
            code: error.code,
            message: safeErrorMessage(error.code),
            retryable: error.retryable,
            requiredScopes:
              error.code === "INSUFFICIENT_SCOPE" ? [mcpInitialScope] : [],
          },
          meta: {
            replayed: false,
            observedAt,
          },
        },
        true,
      );
    }
  }

  async function readResource(
    principal: McpConnectionPrincipal,
    uri: string,
  ) {
    if (uri === "foundry://site") {
      const envelope = await readApplication.getSite(principal);
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(envelope),
      };
    }
    if (uri === "foundry://schemas/content") {
      const envelope = await readApplication.getContentSchema(principal);
      return {
        uri,
        mimeType: "application/schema+json",
        text: JSON.stringify(envelope),
      };
    }
    const match = /^foundry:\/\/content\/(page|post)\/([^/]+)$/u.exec(uri);
    if (match !== null) {
      const envelope = await readApplication.getContent(principal, {
        kind: match[1] as "page" | "post",
        contentId: decodeURIComponent(match[2]!),
      });
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(envelope),
      };
    }
    throw new McpReadError(
      "OBJECT_NOT_FOUND",
      "The requested object was not found.",
    );
  }

  async function handleMcp(
    request: Request,
    principal: McpConnectionPrincipal,
  ) {
    if (request.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405, {
        allow: "POST",
      });
    }
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== canonicalOrigin) {
      return jsonResponse({ error: "origin_not_allowed" }, 403);
    }
    const accept = request.headers.get("accept") ?? "";
    if (
      !accept.includes("application/json") ||
      !accept.includes("text/event-stream") ||
      request.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("application/json") !== true
    ) {
      return jsonResponse({ error: "unsupported_media_type" }, 415);
    }
    let value: unknown;
    try {
      value = await request.json();
    } catch {
      return rpcError(null, -32700, "Parse error");
    }
    if (
      !isRecord(value) ||
      value.jsonrpc !== "2.0" ||
      typeof value.method !== "string" ||
      !hasExactKeys(value, ["jsonrpc", "method"], ["id", "params"])
    ) {
      return rpcError(null, -32600, "Invalid Request");
    }
    const rpc = value as RpcRequest;
    if (rpc.method !== "initialize") {
      const requestedProtocol = request.headers.get("mcp-protocol-version");
      if (requestedProtocol !== protocolVersion) {
        return rpcError(rpc.id, -32600, "Unsupported MCP protocol version");
      }
    }
    if (rpc.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (rpc.method === "initialize") {
      if (
        !isRecord(rpc.params) ||
        rpc.params.protocolVersion !== protocolVersion
      ) {
        return rpcError(rpc.id, -32602, "Unsupported MCP protocol version");
      }
      return rpcResult(rpc.id, {
        protocolVersion,
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
          prompts: { listChanged: false },
        },
        serverInfo: {
          name: "foundry-cms",
          version: "0.1.0",
          description: `${siteName} read-only MCP resource (${mcpContractVersion})`,
        },
      });
    }
    if (rpc.method === "tools/list") {
      return rpcResult(rpc.id, { tools: toolCatalog, nextCursor: null });
    }
    if (rpc.method === "tools/call") {
      if (
        !isRecord(rpc.params) ||
        !hasExactKeys(rpc.params, ["name", "arguments"]) ||
        typeof rpc.params.name !== "string"
      ) {
        return rpcError(rpc.id, -32602, "Invalid tool arguments");
      }
      const result = await callTool(
        principal,
        rpc.params.name,
        rpc.params.arguments,
      );
      return result === null
        ? rpcError(rpc.id, -32602, "Invalid tool arguments")
        : rpcResult(rpc.id, result);
    }
    if (rpc.method === "resources/list") {
      const site = await readApplication.getSite(principal);
      const content = await readApplication.listContent(principal, {
        kind: null,
        limit: 100,
        cursor: null,
      });
      return rpcResult(rpc.id, {
        resources: [
          {
            uri: "foundry://site",
            name: site.result.displayName,
            mimeType: "application/json",
          },
          {
            uri: "foundry://schemas/content",
            name: "Content schema",
            mimeType: "application/schema+json",
          },
          ...content.result.items.map((item) => ({
            uri: `foundry://content/${item.kind}/${encodeURIComponent(item.contentId)}`,
            name: item.title,
            mimeType: "application/json",
          })),
        ],
        nextCursor: null,
      });
    }
    if (rpc.method === "resources/templates/list") {
      return rpcResult(rpc.id, {
        resourceTemplates: [
          {
            uriTemplate: "foundry://content/{kind}/{contentId}",
            name: "Published content",
            mimeType: "application/json",
          },
        ],
        nextCursor: null,
      });
    }
    if (rpc.method === "resources/read") {
      if (
        !isRecord(rpc.params) ||
        !hasExactKeys(rpc.params, ["uri"]) ||
        typeof rpc.params.uri !== "string"
      ) {
        return rpcError(rpc.id, -32602, "Invalid resource request");
      }
      try {
        return rpcResult(rpc.id, {
          contents: [await readResource(principal, rpc.params.uri)],
        });
      } catch (error) {
        if (error instanceof McpReadError) {
          return rpcError(rpc.id, -32002, safeErrorMessage(error.code), {
            code: error.code,
          });
        }
        throw error;
      }
    }
    if (rpc.method === "prompts/list") {
      return rpcResult(rpc.id, { prompts: [], nextCursor: null });
    }
    return rpcError(rpc.id, -32601, "Method not found");
  }

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (
        url.origin === canonicalOrigin &&
        url.pathname === protectedResourceMetadataPath(resourceUri) &&
        request.method === "GET"
      ) {
        return jsonResponse({
          resource: resourceUri,
          authorization_servers: [authorizationIssuer],
          scopes_supported: [mcpInitialScope],
          bearer_methods_supported: ["header"],
          resource_name: `${siteName} — Foundry CMS`,
        });
      }
      if (
        url.origin === canonicalOrigin &&
        url.pathname === "/.well-known/oauth-authorization-server" &&
        request.method === "GET"
      ) {
        return jsonResponse({
          issuer: authorizationIssuer,
          authorization_endpoint: `${canonicalOrigin}${authorizationPath}`,
          token_endpoint: `${resourceUri}/oauth/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: [mcpInitialScope],
        });
      }
      if (
        url.origin === canonicalOrigin &&
        url.pathname === authorizationPath
      ) {
        return handleAuthorization(request);
      }
      if (
        url.origin === canonicalOrigin &&
        url.pathname === ownerRevocationPath
      ) {
        if (
          request.method !== "POST" ||
          request.headers.get("origin") !== canonicalOrigin ||
          request.headers
            .get("content-type")
            ?.toLowerCase()
            .startsWith("application/json") !== true
        ) {
          return jsonResponse({ error: "invalid_request" }, 400);
        }
        let owner;
        try {
          owner = await authenticateOwner(request, {
            mode: "mutate",
            csrfToken: null,
          });
        } catch {
          return jsonResponse({ error: "access_denied" }, 403);
        }
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return jsonResponse({ error: "invalid_request" }, 400);
        }
        if (
          !isRecord(body) ||
          !hasExactKeys(body, ["connectionId"]) ||
          typeof body.connectionId !== "string" ||
          body.connectionId.length < 1 ||
          body.connectionId.length > 200
        ) {
          return jsonResponse({ error: "invalid_request" }, 400);
        }
        const revoked = await store.revokeConnection({
          siteId,
          connectionId: body.connectionId,
          ownerMembershipId: owner.membershipId,
          now: now().toISOString(),
        });
        return revoked
          ? new Response(null, {
              status: 204,
              headers: { "cache-control": "no-store" },
            })
          : jsonResponse({ error: "not_found" }, 404);
      }
      if (
        url.origin === canonicalOrigin &&
        url.pathname === `${resource.pathname}/oauth/token`
      ) {
        return handleToken(request);
      }
      if (
        url.origin !== canonicalOrigin ||
        url.pathname !== resource.pathname
      ) {
        return jsonResponse({ error: "not_found" }, 404);
      }
      const principal = await authenticateMcpRequest(request);
      if (principal instanceof Response) return principal;
      return handleMcp(request, principal);
    },
  };
}
