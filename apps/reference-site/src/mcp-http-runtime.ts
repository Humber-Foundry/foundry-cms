import { SignJWT, jwtVerify } from "jose";

import {
  mcpInitialScope,
  sha256CanonicalJson,
  type McpConnectionGrant,
  type McpConnectionPrincipal,
  type McpConnectionStore,
  type McpCursorCodec,
} from "@foundry/application";
import type { SiteId } from "@foundry/site-definition";

import {
  base64UrlEncode,
  createRequestExecutionContext,
  escapeHtml,
  hasExactKeys,
  isRecord,
  jsonResponse,
  readBoundedText,
  sha256,
  type RequestExecutionContext,
} from "./mcp-http-support";
import {
  createMcpProtocolRuntime,
  mcpProtocolVersion,
} from "./mcp-protocol-runtime";
import type { McpReadApplication } from "./mcp-tool-registry";

export { createSignedMcpCursorCodec } from "./mcp-http-support";

const accessTokenLifetimeSeconds = 5 * 60;
const authorizationCodeLifetimeSeconds = 5 * 60;
const refreshTokenLifetimeSeconds = 30 * 24 * 60 * 60;
const oauthBodyLimitBytes = 16 * 1024;
const rpcTimeoutMs = 10_000;

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
  inputHash: string;
}>;

export type McpAuthorizationRuntimeStore = McpConnectionStore &
  Readonly<{
    createAuthorizationGrant(input: McpAuthorizationGrantInput): Promise<void>;
    exchangeAuthorizationCode(input: {
      codeHash: string;
      codeChallenge: string;
      clientId: string;
      redirectUri: string;
      refreshTokenHash: string;
      refreshFamilyId: string;
      refreshExpiresAt: string;
      now: string;
    }): Promise<
      (McpConnectionGrant & Readonly<{ codeChallenge: string }>) | null
    >;
    revokeConnection(input: {
      siteId: SiteId;
      connectionId: string;
      ownerMembershipId: string;
      now: string;
      reason: string;
      inputHash: string;
    }): Promise<boolean>;
    rotateRefreshToken(input: {
      tokenHash: string;
      nextTokenHash: string;
      clientId: string;
      nextExpiresAt: string;
      now: string;
    }): Promise<
      | Readonly<{ state: "rotated"; connection: McpConnectionGrant }>
      | Readonly<{ state: "reuse_detected" | "invalid" }>
    >;
    consumeRateLimit(input: {
      siteId: SiteId;
      bucketKey: string;
      windowStartedAt: string;
      limit: number;
    }): Promise<boolean>;
  }>;

type OwnerAuthenticationIntent = Readonly<{
  mode: "view" | "mutate";
  csrfToken: string | null;
}>;

type AuthorizationRequest = Readonly<{
  responseType: "code";
  clientId: string;
  clientName: string;
  redirectUri: string;
  resource: string;
  scope: typeof mcpInitialScope;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
}>;

function protectedResourceMetadataPath(resourceUri: string) {
  return `/.well-known/oauth-protected-resource${new URL(resourceUri).pathname}`;
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
  cursors,
  registeredClients,
  authenticateOwner,
  authorizationPath = `${new URL(resourceUri).pathname}/oauth/authorize`,
  ownerRevocationPath = "/api/foundry-cms/mcp-connections/revoke",
  createAuthorizationCode = () =>
    base64UrlEncode(crypto.getRandomValues(new Uint8Array(32))),
  createConnectionId = () => crypto.randomUUID(),
  createActorId = () => crypto.randomUUID(),
  createTokenId = () => crypto.randomUUID(),
  createRefreshToken = () =>
    base64UrlEncode(crypto.getRandomValues(new Uint8Array(32))),
  createRefreshFamilyId = () => crypto.randomUUID(),
  requestTimeoutMs = rpcTimeoutMs,
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
  cursors: McpCursorCodec;
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
  createAuthorizationCode?: () => string;
  createConnectionId?: () => string;
  createActorId?: () => string;
  createTokenId?: () => string;
  createRefreshToken?: () => string;
  createRefreshFamilyId?: () => string;
  requestTimeoutMs?: number;
  now?: () => Date;
}) {
  const resource = new URL(resourceUri);
  const issuer = new URL(authorizationIssuer);
  if (
    resource.protocol !== "https:" ||
    resource.origin !== canonicalOrigin ||
    issuer.protocol !== "https:" ||
    issuer.origin !== canonicalOrigin ||
    signingSecret.length < 32
  ) {
    throw new TypeError("mcp_production_origin_invalid");
  }
  const signingKey = new TextEncoder().encode(signingSecret);
  const metadataUri =
    `${canonicalOrigin}${protectedResourceMetadataPath(resourceUri)}`;
  const challengeHeader =
    `Bearer resource_metadata="${metadataUri}", scope="${mcpInitialScope}"`;
  const protocol = createMcpProtocolRuntime({
    canonicalOrigin,
    siteId,
    siteName,
    store,
    readApplication,
    cursors,
    now,
  });

  function authenticationFailure(error = "invalid_token") {
    return jsonResponse(
      { error },
      401,
      { "www-authenticate": challengeHeader },
    );
  }

  async function authenticateMcpRequest(
    request: Request,
    context: RequestExecutionContext,
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
      const current = await context.waitFor(
        store.findCurrentConnection({
          connectionId: principal.connectionId,
          siteId,
        }),
      );
      if (
        current === null ||
        current.status !== "active" ||
        current.actorId !== principal.actorId ||
        current.clientId !== principal.clientId ||
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

  function readAuthorizationRequest(
    body: unknown,
  ): AuthorizationRequest | null {
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
      responseType: "code",
      clientId: body.client_id,
      clientName: client.name,
      redirectUri: body.redirect_uri,
      resource: body.resource,
      scope: body.scope,
      state: body.state,
      codeChallenge: body.code_challenge,
      codeChallengeMethod: "S256",
    };
  }

  async function readAuthorizationBody(request: Request) {
    const contentType = request.headers.get("content-type")?.toLowerCase();
    if (contentType?.startsWith("application/json") === true) {
      return {
        body: JSON.parse(
          await readBoundedText(request, oauthBodyLimitBytes),
        ) as unknown,
        csrfToken: null,
      };
    }
    if (
      contentType?.startsWith("application/x-www-form-urlencoded") === true
    ) {
      const form = new URLSearchParams(
        await readBoundedText(request, oauthBodyLimitBytes),
      );
      const csrfToken = form.get("csrf_token");
      form.delete("csrf_token");
      return { body: Object.fromEntries(form), csrfToken };
    }
    throw new TypeError("invalid_request");
  }

  function authorizationConsent(
    authorization: AuthorizationRequest,
    csrfToken: string,
  ) {
    const hidden = {
      response_type: authorization.responseType,
      client_id: authorization.clientId,
      redirect_uri: authorization.redirectUri,
      resource: authorization.resource,
      scope: authorization.scope,
      state: authorization.state,
      code_challenge: authorization.codeChallenge,
      code_challenge_method: authorization.codeChallengeMethod,
      csrf_token: csrfToken,
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

  async function handleAuthorization(request: Request) {
    if (request.method === "GET") {
      const authorization = readAuthorizationRequest(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      if (authorization === null) {
        return jsonResponse({ error: "invalid_request" }, 400);
      }
      try {
        const owner = await authenticateOwner(request, {
          mode: "view",
          csrfToken: null,
        });
        return owner.csrfToken === undefined
          ? jsonResponse({ error: "access_denied" }, 403)
          : authorizationConsent(authorization, owner.csrfToken);
      } catch {
        return jsonResponse({ error: "access_denied" }, 403);
      }
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405, {
        allow: "GET, POST",
      });
    }
    if (request.headers.get("origin") !== canonicalOrigin) {
      return jsonResponse({ error: "invalid_request" }, 400);
    }
    let parsed: Awaited<ReturnType<typeof readAuthorizationBody>>;
    try {
      parsed = await readAuthorizationBody(request);
    } catch {
      return jsonResponse({ error: "invalid_request" }, 400);
    }
    const authorization = readAuthorizationRequest(parsed.body);
    if (authorization === null) {
      return jsonResponse({ error: "invalid_request" }, 400);
    }
    let owner;
    try {
      owner = await authenticateOwner(request, {
        mode: "mutate",
        csrfToken: parsed.csrfToken,
      });
    } catch {
      return jsonResponse({ error: "access_denied" }, 403);
    }
    const code = createAuthorizationCode();
    const observedAt = now();
    await store.createAuthorizationGrant({
      connectionId: createConnectionId(),
      actorId: createActorId(),
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
      inputHash: await sha256CanonicalJson({
        clientId: authorization.clientId,
        redirectUri: authorization.redirectUri,
        resource: authorization.resource,
        scope: authorization.scope,
      }),
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

  async function issueAccessToken(connection: McpConnectionGrant) {
    const issuedAt = Math.floor(now().getTime() / 1_000);
    return new SignJWT({
      resource: resourceUri,
      token_type: "access_token",
      connection_id: connection.connectionId,
      client_id: connection.clientId,
      site_id: siteId,
      scope: mcpInitialScope,
    })
      .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
      .setIssuer(authorizationIssuer)
      .setAudience(resourceUri)
      .setSubject(connection.actorId)
      .setIssuedAt(issuedAt)
      .setNotBefore(issuedAt)
      .setExpirationTime(issuedAt + accessTokenLifetimeSeconds)
      .setJti(createTokenId())
      .sign(signingKey);
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
    let form: URLSearchParams;
    try {
      form = new URLSearchParams(
        await readBoundedText(request, oauthBodyLimitBytes),
      );
    } catch {
      return jsonResponse({ error: "invalid_request" }, 400);
    }
    const clientId = form.get("client_id");
    if (form.get("resource") !== resourceUri || clientId === null) {
      return jsonResponse({ error: "invalid_grant" }, 400);
    }
    const observedAt = now();
    let connection: McpConnectionGrant;
    let refreshToken: string;
    if (form.get("grant_type") === "authorization_code") {
      const code = form.get("code");
      const redirectUri = form.get("redirect_uri");
      const verifier = form.get("code_verifier");
      if (
        code === null ||
        redirectUri === null ||
        verifier === null ||
        !/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)
      ) {
        return jsonResponse({ error: "invalid_grant" }, 400);
      }
      const codeChallenge = await sha256(verifier);
      refreshToken = createRefreshToken();
      const exchanged = await store.exchangeAuthorizationCode({
        codeHash: await sha256(code),
        codeChallenge,
        clientId,
        redirectUri,
        refreshTokenHash: await sha256(refreshToken),
        refreshFamilyId: createRefreshFamilyId(),
        refreshExpiresAt: new Date(
          observedAt.getTime() + refreshTokenLifetimeSeconds * 1_000,
        ).toISOString(),
        now: observedAt.toISOString(),
      });
      if (
        exchanged === null ||
        exchanged.status !== "active" ||
        exchanged.siteId !== siteId ||
        exchanged.scopes.length !== 1 ||
        exchanged.scopes[0] !== mcpInitialScope ||
        codeChallenge !== exchanged.codeChallenge
      ) {
        return jsonResponse({ error: "invalid_grant" }, 400);
      }
      connection = exchanged;
    } else if (form.get("grant_type") === "refresh_token") {
      const presented = form.get("refresh_token");
      if (presented === null) {
        return jsonResponse({ error: "invalid_grant" }, 400);
      }
      refreshToken = createRefreshToken();
      const rotation = await store.rotateRefreshToken({
        tokenHash: await sha256(presented),
        nextTokenHash: await sha256(refreshToken),
        clientId,
        nextExpiresAt: new Date(
          observedAt.getTime() + refreshTokenLifetimeSeconds * 1_000,
        ).toISOString(),
        now: observedAt.toISOString(),
      });
      if (rotation.state !== "rotated") {
        return jsonResponse({ error: "invalid_grant" }, 400);
      }
      connection = rotation.connection;
    } else {
      return jsonResponse({ error: "unsupported_grant_type" }, 400);
    }
    return jsonResponse({
      access_token: await issueAccessToken(connection),
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: accessTokenLifetimeSeconds,
      scope: mcpInitialScope,
      resource: resourceUri,
    });
  }

  async function handleOwnerRevocation(request: Request) {
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
      body = JSON.parse(await readBoundedText(request, oauthBodyLimitBytes));
    } catch {
      return jsonResponse({ error: "invalid_request" }, 400);
    }
    if (
      !isRecord(body) ||
      !hasExactKeys(body, ["connectionId", "reason"]) ||
      typeof body.connectionId !== "string" ||
      body.connectionId.length < 1 ||
      body.connectionId.length > 200 ||
      typeof body.reason !== "string" ||
      body.reason.trim().length < 1 ||
      body.reason.length > 240
    ) {
      return jsonResponse({ error: "invalid_request" }, 400);
    }
    const reason = body.reason.trim();
    const revoked = await store.revokeConnection({
      siteId,
      connectionId: body.connectionId,
      ownerMembershipId: owner.membershipId,
      now: now().toISOString(),
      reason,
      inputHash: await sha256CanonicalJson({
        connectionId: body.connectionId,
        reason,
      }),
    });
    return revoked
      ? new Response(null, {
          status: 204,
          headers: { "cache-control": "no-store" },
        })
      : jsonResponse({ error: "not_found" }, 404);
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
          grant_types_supported: ["authorization_code", "refresh_token"],
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
        return handleOwnerRevocation(request);
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
      const execution = createRequestExecutionContext(requestTimeoutMs);
      try {
        return await protocol.handle(
          request,
          () => authenticateMcpRequest(request, execution.context),
          execution.context,
        );
      } finally {
        execution.dispose();
      }
    },
  };
}
