import { SignJWT, jwtVerify } from "jose";

import {
  mcpInitialScope,
  mcpSupportedScopes,
  sha256CanonicalJson,
  type McpConnectionGrant,
  type McpConnectionPrincipal,
  type McpConnectionStore,
  type McpCursorCodec,
} from "@humber-foundry/application";
import type { SiteId } from "@humber-foundry/site-definition";

import {
  isValidMcpRedirectUri,
  mcpClientRegistrationLimits,
  readMcpClientRegistration,
  type McpClientRegistrationMetadata,
} from "./mcp-client-registration";
import {
  base64UrlEncode,
  createRequestExecutionContext,
  escapeHtml,
  hasExactKeys,
  isRecord,
  jsonResponse,
  readBoundedText,
  readsJsonMediaType,
  RequestDeadlineExceededError,
  sha256,
  type RequestExecutionContext,
} from "./mcp-http-support";
import {
  createMcpProtocolRuntime,
  mcpProtocolVersion,
  type AuthenticatedMcpSession,
} from "./mcp-protocol-runtime";
import type { McpReadApplication } from "./mcp-tool-registry";

export { createSignedMcpCursorCodec } from "./mcp-http-support";

const accessTokenLifetimeSeconds = 5 * 60;
const stepUpTokenLifetimeSeconds = 5 * 60;
const authorizationCodeLifetimeSeconds = 5 * 60;
const refreshTokenLifetimeSeconds = 30 * 24 * 60 * 60;
const oauthBodyLimitBytes = 16 * 1024;
const rpcTimeoutMs = 10_000;

/** Registrations accepted for one site in one hour. */
const clientRegistrationsPerHour = 20;
/** Registered clients kept for one site. A registration grants nothing. */
const clientRegistrationCapacity = 500;
const authorizationStateLimit = 512;
const clientIdLimit = 2_048;

/** Plain words shown to the Owner for each scope on the consent screen. */
const scopeLabels: Readonly<Record<string, string>> = Object.freeze({
  "site.read": "Read this site",
  "content.draft": "Draft content",
  "design.draft": "Draft design",
  "publication.schedule": "Schedule publication",
  "publication.publish": "Publish approved work",
  "campaign.draft": "Draft newsletter campaigns",
  "campaign.test": "Send a campaign test to verified addresses",
  "analytics.read": "Read aggregate analytics",
});

export type McpRegisteredClient = Readonly<{
  clientId: string;
  name: string;
  redirectUris: ReadonlyArray<string>;
  source: "environment" | "dynamic";
}>;

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
  scopes: ReadonlyArray<string>;
  stepUpConnectionId?: string;
  stepUpExpectedScopes?: ReadonlyArray<string>;
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
      (
        McpConnectionGrant &
        Readonly<{ codeChallenge: string; redirectUri: string }>
      ) | null
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
      | Readonly<{
          state: "rotated";
          connection: McpConnectionGrant &
            Readonly<{ redirectUri: string }>;
        }>
      | Readonly<{ state: "reuse_detected" | "invalid" }>
    >;
    consumeRateLimit(input: {
      siteId: SiteId;
      bucketKey: string;
      windowStartedAt: string;
      limit: number;
    }): Promise<boolean>;
    findRegisteredClient(input: {
      siteId: SiteId;
      clientId: string;
    }): Promise<McpRegisteredClient | null>;
    registerClient(input: {
      siteId: SiteId;
      clientId: string;
      metadata: McpClientRegistrationMetadata;
      now: string;
      capacity: number;
    }): Promise<"registered" | "capacity_reached">;
  }>;

type OwnerAuthenticationIntent = Readonly<{
  mode: "view" | "mutate";
  csrfToken: string | null;
}>;

type AuthorizationRequest = Readonly<{
  responseType: "code";
  clientId: string;
  redirectUri: string;
  resource: string;
  scope: string;
  scopes: ReadonlyArray<string>;
  connectionId: string | null;
  state: string | null;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  stepUpToken: string | null;
}>;

type ResolvedAuthorizationRequest = AuthorizationRequest &
  Readonly<{ clientName: string }>;

function protectedResourceMetadataPath(resourceUri: string) {
  return `/.well-known/oauth-protected-resource${new URL(resourceUri).pathname}`;
}

function canonicalScopes(scopes: ReadonlyArray<string>): string {
  return mcpSupportedScopes
    .filter((scope) => scopes.includes(scope))
    .join(" ");
}

/**
 * Read a scope string this server issued. Server-issued scope strings are
 * always canonical, so anything else is a forged or altered token.
 */
function readRequestedScopes(value: unknown): ReadonlyArray<string> | null {
  if (typeof value !== "string") return null;
  const requested = value.split(" ").filter(Boolean);
  if (
    requested.length < 1 ||
    new Set(requested).size !== requested.length ||
    !requested.includes(mcpInitialScope) ||
    requested.some(
      (scope) =>
        !(mcpSupportedScopes as ReadonlyArray<string>).includes(scope),
    ) ||
    canonicalScopes(requested) !== value
  ) {
    return null;
  }
  return Object.freeze([...requested]);
}

/**
 * Read the scopes a client asks for at the authorize endpoint. A client may
 * send supported scopes in any order and may repeat none of them. An absent
 * `scope` parameter means the smallest useful request. The Owner still decides
 * what is granted on the consent screen, so a large request is not a grant.
 */
function readAuthorizationScopes(
  value: unknown,
): ReadonlyArray<string> | null {
  if (value === undefined || value === null || value === "") {
    return Object.freeze([mcpInitialScope]);
  }
  if (typeof value !== "string") return null;
  const requested = value.split(" ").filter(Boolean);
  if (
    requested.length < 1 ||
    new Set(requested).size !== requested.length ||
    requested.some(
      (scope) =>
        !(mcpSupportedScopes as ReadonlyArray<string>).includes(scope),
    )
  ) {
    return null;
  }
  return Object.freeze(
    mcpSupportedScopes.filter(
      (scope) => scope === mcpInitialScope || requested.includes(scope),
    ),
  );
}

/**
 * Read the scopes the Owner ticked on the consent screen. The result must stay
 * inside what the client asked for and must keep `site.read`.
 */
function readGrantedScopes(
  value: unknown,
  requested: ReadonlyArray<string>,
): ReadonlyArray<string> | null {
  const granted =
    value === undefined || value === null
      ? requested
      : typeof value === "string"
        ? value.split(" ").filter(Boolean)
        : null;
  if (
    granted === null ||
    granted.length < 1 ||
    new Set(granted).size !== granted.length ||
    !granted.includes(mcpInitialScope) ||
    granted.some((scope) => !requested.includes(scope))
  ) {
    return null;
  }
  return Object.freeze(
    mcpSupportedScopes.filter((scope) => granted.includes(scope)),
  );
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
  registrationPath = `${new URL(resourceUri).pathname}/oauth/register`,
  ownerRevocationPath = "/api/foundry-cms/mcp-connections/revoke",
  createRegisteredClientId = () =>
    `mcpc_${base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))}`,
  createAuthorizationCode = () =>
    base64UrlEncode(crypto.getRandomValues(new Uint8Array(32))),
  createConnectionId = () => crypto.randomUUID(),
  createActorId = () => crypto.randomUUID(),
  createTokenId = () => crypto.randomUUID(),
  createRefreshToken = () =>
    base64UrlEncode(crypto.getRandomValues(new Uint8Array(32))),
  createRefreshFamilyId = () => crypto.randomUUID(),
  requestTimeoutMs = rpcTimeoutMs,
  defer = () => {},
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
  /**
   * The operator's optional environment allowlist. When it holds at least one
   * client, only those clients may authorize and dynamic registration is
   * refused. When it is empty, any client may register and every registration
   * still waits for Owner consent.
   */
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
  registrationPath?: string;
  ownerRevocationPath?: string;
  createRegisteredClientId?: () => string;
  createAuthorizationCode?: () => string;
  createConnectionId?: () => string;
  createActorId?: () => string;
  createTokenId?: () => string;
  createRefreshToken?: () => string;
  createRefreshFamilyId?: () => string;
  requestTimeoutMs?: number;
  defer?: (promise: Promise<unknown>) => void;
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
  const authorizationEndpoint = new URL(
    authorizationPath,
    canonicalOrigin,
  ).toString();
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
  ): Promise<AuthenticatedMcpSession | Response> {
    const authorization = request.headers.get("authorization");
    if (
      authorization === null ||
      !authorization.startsWith("Bearer ") ||
      new URL(request.url).searchParams.has("access_token")
    ) {
      return authenticationFailure();
    }
    let principal: McpConnectionPrincipal;
    let tokenId: string;
    let tokenExpiresAt: number;
    try {
      const { payload, protectedHeader } = await context.run(() =>
        jwtVerify(authorization.slice("Bearer ".length), signingKey, {
          algorithms: ["HS256"],
          issuer: authorizationIssuer,
          audience: resourceUri,
          clockTolerance: 5,
          currentDate: now(),
        }),
      );
      const tokenScopes = readRequestedScopes(payload.scope);
      if (
        protectedHeader.alg !== "HS256" ||
        payload.resource !== resourceUri ||
        payload.token_type !== "access_token" ||
        typeof payload.sub !== "string" ||
        typeof payload.connection_id !== "string" ||
        typeof payload.client_id !== "string" ||
        typeof payload.jti !== "string" ||
        typeof payload.exp !== "number" ||
        payload.site_id !== siteId ||
        tokenScopes === null
      ) {
        return authenticationFailure();
      }
      principal = {
        connectionId: payload.connection_id,
        actorId: payload.sub,
        clientId: payload.client_id,
        siteId,
        scopes: tokenScopes,
      };
      tokenId = payload.jti;
      tokenExpiresAt = payload.exp;
    } catch (error) {
      if (error instanceof RequestDeadlineExceededError) throw error;
      return authenticationFailure();
    }
    const current = await context.run(() =>
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
      principal.scopes.some((scope) => !current.scopes.includes(scope))
    ) {
      return authenticationFailure(
        current?.status === "revoked"
          ? "connection_revoked"
          : "invalid_token",
      );
    }
    let sessionState: AuthenticatedMcpSession["sessionState"] = "missing";
    const presentedSession = request.headers.get("mcp-session-id");
    if (presentedSession !== null) {
      try {
        const { payload, protectedHeader } = await context.run(() =>
          jwtVerify(presentedSession, signingKey, {
            algorithms: ["HS256"],
            issuer: authorizationIssuer,
            audience: resourceUri,
            clockTolerance: 5,
            currentDate: now(),
          }),
        );
        sessionState =
          protectedHeader.alg === "HS256" &&
          protectedHeader.typ === "mcp-session+jwt" &&
          payload.token_type === "mcp_session" &&
          payload.access_token_id === tokenId &&
          payload.connection_id === principal.connectionId &&
          payload.scope === canonicalScopes(principal.scopes) &&
          payload.sub === principal.actorId
            ? "valid"
            : "invalid";
      } catch (error) {
        if (error instanceof RequestDeadlineExceededError) throw error;
        sessionState = "invalid";
      }
    }
    return {
      principal,
      sessionState,
      async issueSessionId() {
        return new SignJWT({
          token_type: "mcp_session",
          access_token_id: tokenId,
          connection_id: principal.connectionId,
          scope: canonicalScopes(principal.scopes),
        })
          .setProtectedHeader({ alg: "HS256", typ: "mcp-session+jwt" })
          .setIssuer(authorizationIssuer)
          .setAudience(resourceUri)
          .setSubject(principal.actorId)
          .setIssuedAt(Math.floor(now().getTime() / 1_000))
          .setExpirationTime(tokenExpiresAt)
          .setJti(crypto.randomUUID())
          .sign(signingKey);
      },
    };
  }

  /**
   * Read the authorize parameters this server uses. Parameters it does not
   * know are ignored, not refused, because real clients send extra OAuth
   * parameters. Every parameter it does use is still checked exactly.
   */
  function readAuthorizationRequest(
    body: unknown,
  ): AuthorizationRequest | null {
    if (!isRecord(body)) return null;
    const scopes = readAuthorizationScopes(body.scope);
    if (
      body.response_type !== "code" ||
      typeof body.client_id !== "string" ||
      body.client_id.length < 1 ||
      body.client_id.length > clientIdLimit ||
      !isValidMcpRedirectUri(body.redirect_uri) ||
      // A 2025-03-26 client sends no resource indicator. This server serves
      // exactly one resource, so an absent indicator is this resource.
      (body.resource !== undefined && body.resource !== resourceUri) ||
      scopes === null ||
      (body.connection_id !== undefined &&
        (
          typeof body.connection_id !== "string" ||
          body.connection_id.length < 1 ||
          body.connection_id.length > 200
        )) ||
      (body.step_up_token !== undefined &&
        (
          typeof body.step_up_token !== "string" ||
          body.step_up_token.length < 1 ||
          body.step_up_token.length > 4_096
        )) ||
      // Step-up needs both halves. One without the other is a malformed ask.
      (body.connection_id === undefined) !==
        (body.step_up_token === undefined) ||
      (body.state !== undefined &&
        (
          typeof body.state !== "string" ||
          body.state.length < 1 ||
          body.state.length > authorizationStateLimit
        )) ||
      typeof body.code_challenge !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(body.code_challenge) ||
      body.code_challenge_method !== "S256"
    ) {
      return null;
    }
    return {
      responseType: "code",
      clientId: body.client_id,
      redirectUri: body.redirect_uri,
      resource: resourceUri,
      scope: canonicalScopes(scopes),
      scopes,
      connectionId:
        typeof body.connection_id === "string"
          ? body.connection_id
          : null,
      stepUpToken:
        typeof body.step_up_token === "string"
          ? body.step_up_token
          : null,
      state: typeof body.state === "string" ? body.state : null,
      codeChallenge: body.code_challenge,
      codeChallengeMethod: "S256",
    };
  }

  const environmentClientIds = Object.keys(registeredClients);
  const registrationEnabled = environmentClientIds.length === 0;

  /**
   * Find the client behind a `client_id`. The operator's environment allowlist
   * wins. Dynamically registered clients are only consulted when the operator
   * has not turned the allowlist on.
   */
  async function findClient(
    clientId: string,
  ): Promise<McpRegisteredClient | null> {
    const configured = registeredClients[clientId];
    if (configured !== undefined) {
      return {
        clientId,
        name: configured.name,
        redirectUris: configured.redirectUris,
        source: "environment",
      };
    }
    if (!registrationEnabled) return null;
    return store.findRegisteredClient({ siteId, clientId });
  }

  /**
   * Resolve the client and check the redirect URI matches one it registered,
   * character for character.
   */
  async function resolveAuthorizationRequest(
    authorization: AuthorizationRequest,
  ): Promise<ResolvedAuthorizationRequest | null> {
    const client = await findClient(authorization.clientId);
    if (
      client === null ||
      !client.redirectUris.includes(authorization.redirectUri)
    ) {
      return null;
    }
    return { ...authorization, clientName: client.name };
  }

  async function readAuthorizationBody(request: Request) {
    const contentType = request.headers.get("content-type")?.toLowerCase();
    if (readsJsonMediaType(request)) {
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
      // The consent screen submits one checkbox per approved scope, so this
      // field repeats. Join the ticked values into one scope string.
      const granted = form.getAll("granted_scope");
      form.delete("granted_scope");
      return {
        body: {
          ...Object.fromEntries(form),
          ...(granted.length === 0
            ? {}
            : { granted_scope: granted.join(" ") }),
        },
        csrfToken,
      };
    }
    throw new TypeError("invalid_request");
  }

  async function verifyStepUpAuthorization(
    authorization: AuthorizationRequest,
  ): Promise<
    Readonly<{
      valid: boolean;
      connection: McpConnectionGrant | null;
    }>
  > {
    if (
      authorization.connectionId === null ||
      authorization.stepUpToken === null
    ) {
      // A first authorization may ask for several scopes. The Owner decides
      // which of them to grant on the consent screen.
      return { valid: true, connection: null };
    }
    try {
      const { payload, protectedHeader } = await jwtVerify(
        authorization.stepUpToken,
        signingKey,
        {
          algorithms: ["HS256"],
          issuer: authorizationIssuer,
          audience: authorizationEndpoint,
          clockTolerance: 5,
          currentDate: now(),
        },
      );
      const tokenScopes = readRequestedScopes(payload.scope);
      if (
        protectedHeader.alg !== "HS256" ||
        protectedHeader.typ !== "step-up+jwt" ||
        payload.token_type !== "step_up_intent" ||
        payload.resource !== resourceUri ||
        payload.connection_id !== authorization.connectionId ||
        payload.client_id !== authorization.clientId ||
        payload.site_id !== siteId ||
        payload.redirect_uri !== authorization.redirectUri ||
        typeof payload.sub !== "string" ||
        typeof payload.access_token_id !== "string" ||
        tokenScopes === null
      ) {
        return { valid: false, connection: null };
      }
      const connection = await store.findCurrentConnection({
        connectionId: authorization.connectionId,
        siteId,
      });
      if (
        connection === null ||
        connection.status !== "active" ||
        connection.actorId !== payload.sub ||
        connection.clientId !== authorization.clientId ||
        canonicalScopes(connection.scopes) !== canonicalScopes(tokenScopes) ||
        authorization.scopes.length <= connection.scopes.length ||
        connection.scopes.some(
          (scope) => !authorization.scopes.includes(scope),
        )
      ) {
        return { valid: false, connection: null };
      }
      return { valid: true, connection };
    } catch {
      return { valid: false, connection: null };
    }
  }

  function authorizationConsent(
    authorization: ResolvedAuthorizationRequest,
    csrfToken: string,
    stepUpConnection: McpConnectionGrant | null,
  ) {
    const hidden = {
      response_type: authorization.responseType,
      client_id: authorization.clientId,
      redirect_uri: authorization.redirectUri,
      resource: authorization.resource,
      scope: authorization.scope,
      ...(authorization.state === null ? {} : { state: authorization.state }),
      code_challenge: authorization.codeChallenge,
      code_challenge_method: authorization.codeChallengeMethod,
      csrf_token: csrfToken,
      ...(authorization.connectionId === null
        ? {}
        : {
            connection_id: authorization.connectionId,
            step_up_token: authorization.stepUpToken!,
          }),
    };
    const fields = Object.entries(hidden)
      .map(
        ([name, value]) =>
          `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
      )
      .join("\n");
    // Scopes the connection already holds cannot be dropped here. Removing a
    // scope still requires revoking the connection.
    const fixedScopes = new Set<string>([
      mcpInitialScope,
      ...(stepUpConnection?.scopes ?? []),
    ]);
    const choices = authorization.scopes
      .map((scope) => {
        const label = `${escapeHtml(scopeLabels[scope] ?? scope)} (<code>${escapeHtml(scope)}</code>)`;
        return fixedScopes.has(scope)
          ? `<li><input type="checkbox" checked disabled> ${label} — always included<input type="hidden" name="granted_scope" value="${escapeHtml(scope)}"></li>`
          : `<li><label><input type="checkbox" name="granted_scope" value="${escapeHtml(scope)}" checked> ${label}</label></li>`;
      })
      .join("\n        ");
    const connectionDetails =
      stepUpConnection === null
        ? ""
        : `<dt>Existing connection</dt><dd>${
            escapeHtml(stepUpConnection.connectionId)
          }</dd>
      <dt>Current permissions</dt><dd>${
        escapeHtml(stepUpConnection.scopes.join(", "))
      }</dd>`;
    return new Response(
      `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Connect MCP client</title></head>
  <body>
    <main>
      <h1>Connect ${escapeHtml(authorization.clientName)}</h1>
      <p>${
        stepUpConnection === null
          ? "Grant this connection access to"
          : "Add permissions to this exact existing connection for"
      } ${escapeHtml(siteName)}.</p>
      <p>The client name above comes from the client. Treat it as a claim, not
      as proof. Approve only a client you started yourself.</p>
      <dl>${connectionDetails}<dt>Client identifier</dt><dd>${escapeHtml(authorization.clientId)}</dd><dt>Return address</dt><dd>${escapeHtml(authorization.redirectUri)}</dd></dl>
      <form method="post" action="${escapeHtml(authorizationPath)}">
        ${fields}
        <fieldset>
          <legend>Permissions to approve</legend>
          <p>Clear any permission you do not want. You can approve fewer
          permissions than the client asked for.</p>
          <ul>
        ${choices}
          </ul>
        </fieldset>
        <button type="submit">${
          stepUpConnection === null
            ? "Approve this connection"
            : "Approve added permissions"
        }</button>
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
      const parameters = readAuthorizationRequest(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      const authorization =
        parameters === null
          ? null
          : await resolveAuthorizationRequest(parameters);
      if (authorization === null) {
        return jsonResponse({ error: "invalid_request" }, 400);
      }
      try {
        const owner = await authenticateOwner(request, {
          mode: "view",
          csrfToken: null,
        });
        const stepUp = await verifyStepUpAuthorization(authorization);
        if (!stepUp.valid) {
          return jsonResponse({ error: "invalid_request" }, 400);
        }
        return owner.csrfToken === undefined
          ? jsonResponse({ error: "access_denied" }, 403)
          : authorizationConsent(
              authorization,
              owner.csrfToken,
              stepUp.connection,
            );
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
    const parameters = readAuthorizationRequest(parsed.body);
    const authorization =
      parameters === null
        ? null
        : await resolveAuthorizationRequest(parameters);
    if (authorization === null) {
      return jsonResponse({ error: "invalid_request" }, 400);
    }
    const stepUp = await verifyStepUpAuthorization(authorization);
    if (!stepUp.valid) {
      return jsonResponse({ error: "invalid_request" }, 400);
    }
    // The Owner may approve fewer permissions than the client asked for.
    const granted = readGrantedScopes(
      isRecord(parsed.body) ? parsed.body.granted_scope : undefined,
      authorization.scopes,
    );
    if (
      granted === null ||
      // A step-up may only add. Dropping a held scope needs a revocation.
      (stepUp.connection !== null &&
        (granted.length <= stepUp.connection.scopes.length ||
          stepUp.connection.scopes.some(
            (scope) => !granted.includes(scope),
          )))
    ) {
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
        scope: canonicalScopes(granted),
        connectionId: authorization.connectionId,
      }),
      scopes: granted,
      ...(authorization.connectionId === null
        ? {}
        : {
            stepUpConnectionId: authorization.connectionId,
            stepUpExpectedScopes: stepUp.connection!.scopes,
          }),
    });
    const redirect = new URL(authorization.redirectUri);
    redirect.searchParams.set("code", code);
    if (authorization.state !== null) {
      redirect.searchParams.set("state", authorization.state);
    }
    return new Response(null, {
      status: 303,
      headers: {
        "cache-control": "no-store",
        location: redirect.toString(),
      },
    });
  }

  async function issueAccessToken(
    connection: McpConnectionGrant,
    accessTokenId: string,
  ) {
    const issuedAt = Math.floor(now().getTime() / 1_000);
    return new SignJWT({
      resource: resourceUri,
      token_type: "access_token",
      connection_id: connection.connectionId,
      client_id: connection.clientId,
      site_id: siteId,
      scope: canonicalScopes(connection.scopes),
    })
      .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
      .setIssuer(authorizationIssuer)
      .setAudience(resourceUri)
      .setSubject(connection.actorId)
      .setIssuedAt(issuedAt)
      .setNotBefore(issuedAt)
      .setExpirationTime(issuedAt + accessTokenLifetimeSeconds)
      .setJti(accessTokenId)
      .sign(signingKey);
  }

  async function issueStepUpToken(
    connection: McpConnectionGrant,
    accessTokenId: string,
    redirectUri: string,
  ) {
    const issuedAt = Math.floor(now().getTime() / 1_000);
    return new SignJWT({
      resource: resourceUri,
      token_type: "step_up_intent",
      access_token_id: accessTokenId,
      connection_id: connection.connectionId,
      client_id: connection.clientId,
      site_id: siteId,
      redirect_uri: redirectUri,
      scope: canonicalScopes(connection.scopes),
    })
      .setProtectedHeader({ alg: "HS256", typ: "step-up+jwt" })
      .setIssuer(authorizationIssuer)
      .setAudience(authorizationEndpoint)
      .setSubject(connection.actorId)
      .setIssuedAt(issuedAt)
      .setNotBefore(issuedAt)
      .setExpirationTime(issuedAt + stepUpTokenLifetimeSeconds)
      .setJti(accessTokenId)
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
    let connectionRedirectUri: string;
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
        readRequestedScopes(canonicalScopes(exchanged.scopes)) === null ||
        codeChallenge !== exchanged.codeChallenge
      ) {
        return jsonResponse({ error: "invalid_grant" }, 400);
      }
      connection = exchanged;
      connectionRedirectUri = exchanged.redirectUri;
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
      connectionRedirectUri = rotation.connection.redirectUri;
    } else {
      return jsonResponse({ error: "unsupported_grant_type" }, 400);
    }
    const accessTokenId = createTokenId();
    return jsonResponse({
      access_token: await issueAccessToken(connection, accessTokenId),
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: accessTokenLifetimeSeconds,
      scope: canonicalScopes(connection.scopes),
      resource: resourceUri,
      connection_id: connection.connectionId,
      step_up_token: await issueStepUpToken(
        connection,
        accessTokenId,
        connectionRedirectUri,
      ),
    });
  }

  function registrationError(
    error: string,
    description: string,
    status = 400,
    headers: Record<string, string> = {},
  ) {
    return jsonResponse({ error, error_description: description }, status, headers);
  }

  /**
   * RFC 7591 dynamic client registration.
   *
   * A registration is a name and a set of return addresses. It grants nothing:
   * no connection row, no actor, no scope and no token exist until an Owner
   * approves the client on the consent screen behind human sign-in. This
   * endpoint must stay outside the installation's Cloudflare Access
   * application, because a client calls it with no human present.
   */
  async function handleClientRegistration(request: Request) {
    if (!registrationEnabled) {
      return registrationError(
        "access_denied",
        "This installation registers clients from its operator allowlist only.",
        403,
      );
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405, {
        allow: "POST",
      });
    }
    if (!readsJsonMediaType(request)) {
      return registrationError(
        "invalid_client_metadata",
        "The registration request must be application/json.",
      );
    }
    const observedAt = now();
    const windowStartedAt = new Date(
      Math.floor(observedAt.getTime() / 3_600_000) * 3_600_000,
    ).toISOString();
    const allowed = await store.consumeRateLimit({
      siteId,
      bucketKey: "client_registration",
      windowStartedAt,
      limit: clientRegistrationsPerHour,
    });
    if (!allowed) {
      return registrationError(
        "temporarily_unavailable",
        "This site has reached its client registration limit for this hour.",
        429,
        { "retry-after": "3600" },
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(
        await readBoundedText(
          request,
          mcpClientRegistrationLimits.maxBodyBytes,
        ),
      );
    } catch {
      return registrationError(
        "invalid_client_metadata",
        "The registration request must be a JSON object within the size limit.",
      );
    }
    const registration = readMcpClientRegistration(body);
    if (!registration.ok) {
      return registrationError(registration.error, registration.description);
    }
    const clientId = createRegisteredClientId();
    const outcome = await store.registerClient({
      siteId,
      clientId,
      metadata: registration.metadata,
      now: observedAt.toISOString(),
      capacity: clientRegistrationCapacity,
    });
    if (outcome === "capacity_reached") {
      return registrationError(
        "temporarily_unavailable",
        "This site is holding the maximum number of registered clients.",
        429,
        { "retry-after": "3600" },
      );
    }
    return jsonResponse(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(observedAt.getTime() / 1_000),
        client_name: registration.metadata.clientName,
        redirect_uris: registration.metadata.redirectUris,
        grant_types: registration.metadata.grantTypes,
        response_types: registration.metadata.responseTypes,
        token_endpoint_auth_method:
          registration.metadata.tokenEndpointAuthMethod,
        ...(registration.metadata.clientUri === null
          ? {}
          : { client_uri: registration.metadata.clientUri }),
        ...(registration.metadata.logoUri === null
          ? {}
          : { logo_uri: registration.metadata.logoUri }),
        ...(registration.metadata.softwareId === null
          ? {}
          : { software_id: registration.metadata.softwareId }),
        ...(registration.metadata.softwareVersion === null
          ? {}
          : { software_version: registration.metadata.softwareVersion }),
        ...(registration.metadata.scope === null
          ? {}
          : { scope: registration.metadata.scope }),
      },
      201,
    );
  }

  async function handleOwnerRevocation(request: Request) {
    if (
      request.method !== "POST" ||
      request.headers.get("origin") !== canonicalOrigin ||
      !readsJsonMediaType(request)
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

  function requiredScopesFromProtocolResponse(
    value: unknown,
  ): ReadonlyArray<string> | null {
    if (!isRecord(value)) return null;
    const result = isRecord(value.result) ? value.result : null;
    const structuredContent =
      result !== null && isRecord(result.structuredContent)
        ? result.structuredContent
        : null;
    const toolError =
      structuredContent !== null && isRecord(structuredContent.error)
        ? structuredContent.error
        : null;
    const rpcErrorValue = isRecord(value.error) ? value.error : null;
    const rpcErrorData =
      rpcErrorValue !== null && isRecord(rpcErrorValue.data)
        ? rpcErrorValue.data
        : null;
    const error = toolError?.code === "INSUFFICIENT_SCOPE"
      ? toolError
      : rpcErrorData?.code === "INSUFFICIENT_SCOPE"
        ? rpcErrorData
        : null;
    if (
      error === null ||
      !Array.isArray(error.requiredScopes) ||
      error.requiredScopes.length < 1 ||
      error.requiredScopes.some(
        (scope) =>
          typeof scope !== "string" ||
          !(mcpSupportedScopes as ReadonlyArray<string>).includes(scope),
      )
    ) {
      return null;
    }
    return error.requiredScopes;
  }

  async function applyInsufficientScopeChallenge(response: Response) {
    if (
      response.status !== 200 ||
      !response.headers.get("content-type")?.includes("application/json")
    ) {
      return response;
    }
    let requiredScopes: ReadonlyArray<string> | null = null;
    try {
      requiredScopes = requiredScopesFromProtocolResponse(
        await response.clone().json(),
      );
    } catch {
      return response;
    }
    if (requiredScopes === null) return response;
    const scopes = canonicalScopes([
      mcpInitialScope,
      ...requiredScopes,
    ]);
    const headers = new Headers(response.headers);
    headers.set(
      "www-authenticate",
      `Bearer error="insufficient_scope", ` +
        `resource_metadata="${metadataUri}", scope="${scopes}"`,
    );
    return new Response(response.body, {
      status: 403,
      statusText: "Forbidden",
      headers,
    });
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
          scopes_supported: mcpSupportedScopes,
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
          ...(registrationEnabled
            ? {
                registration_endpoint:
                  `${canonicalOrigin}${registrationPath}`,
              }
            : {}),
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: mcpSupportedScopes,
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
        url.pathname === registrationPath
      ) {
        return handleClientRegistration(request);
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
      const execution = createRequestExecutionContext(
        requestTimeoutMs,
        defer,
      );
      try {
        return await applyInsufficientScopeChallenge(
          await protocol.handle(
            request,
            () => authenticateMcpRequest(request, execution.context),
            execution.context,
          ),
        );
      } finally {
        execution.dispose();
      }
    },
  };
}
