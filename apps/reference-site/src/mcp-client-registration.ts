import { mcpSupportedScopes } from "@humber-foundry/application";

import { isRecord } from "./mcp-http-support";

/**
 * Bounds for one dynamic client registration (RFC 7591). Registration is an
 * unauthenticated write, so every field is bounded before it reaches storage.
 */
export const mcpClientRegistrationLimits = Object.freeze({
  maxRedirectUris: 5,
  maxRedirectUriLength: 2_048,
  maxNameLength: 120,
  maxUriLength: 2_048,
  maxSoftwareFieldLength: 120,
  maxBodyBytes: 8 * 1_024,
});

export type McpClientRegistrationMetadata = Readonly<{
  clientName: string;
  redirectUris: ReadonlyArray<string>;
  grantTypes: ReadonlyArray<string>;
  responseTypes: ReadonlyArray<string>;
  tokenEndpointAuthMethod: "none";
  clientUri: string | null;
  logoUri: string | null;
  softwareId: string | null;
  softwareVersion: string | null;
  scope: string | null;
}>;

export type McpClientRegistrationResult =
  | Readonly<{ ok: true; metadata: McpClientRegistrationMetadata }>
  | Readonly<{
      ok: false;
      error: "invalid_redirect_uri" | "invalid_client_metadata";
      description: string;
    }>;

const supportedGrantTypes = ["authorization_code", "refresh_token"] as const;

/**
 * A redirect URI this server can match exactly. Remote redirects must be
 * HTTPS. Loopback redirects are allowed because installed clients, including
 * Claude Code, receive their authorization code on a local port.
 */
export function isValidMcpRedirectUri(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > mcpClientRegistrationLimits.maxRedirectUriLength ||
    value.includes("*")
  ) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash !== "") return false;
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "localhost")
  );
}

function isBoundedUri(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > mcpClientRegistrationLimits.maxUriLength
  ) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum
  );
}

function invalidMetadata(description: string): McpClientRegistrationResult {
  return { ok: false, error: "invalid_client_metadata", description };
}

function invalidRedirect(description: string): McpClientRegistrationResult {
  return { ok: false, error: "invalid_redirect_uri", description };
}

function readStringArray(value: unknown): ReadonlyArray<string> | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as ReadonlyArray<string>)
    : null;
}

/**
 * Read one RFC 7591 client registration request. Unknown members are ignored,
 * as RFC 7591 allows, so a client that sends extra metadata still registers.
 */
export function readMcpClientRegistration(
  body: unknown,
): McpClientRegistrationResult {
  if (!isRecord(body)) {
    return invalidMetadata("The registration request must be a JSON object.");
  }

  const redirectUris = readStringArray(body.redirect_uris);
  if (
    redirectUris === null ||
    redirectUris.length < 1 ||
    redirectUris.length > mcpClientRegistrationLimits.maxRedirectUris
  ) {
    return invalidRedirect(
      `redirect_uris must list 1 to ${mcpClientRegistrationLimits.maxRedirectUris} redirect URIs.`,
    );
  }
  if (!redirectUris.every(isValidMcpRedirectUri)) {
    return invalidRedirect(
      "Every redirect URI must be HTTPS or an exact loopback address, with no wildcard and no fragment.",
    );
  }
  if (new Set(redirectUris).size !== redirectUris.length) {
    return invalidRedirect("redirect_uris must not repeat a redirect URI.");
  }

  if (
    body.token_endpoint_auth_method !== undefined &&
    body.token_endpoint_auth_method !== "none"
  ) {
    return invalidMetadata(
      "This server issues public clients only, so token_endpoint_auth_method must be \"none\".",
    );
  }

  const grantTypes =
    body.grant_types === undefined
      ? supportedGrantTypes
      : readStringArray(body.grant_types);
  if (
    grantTypes === null ||
    grantTypes.length < 1 ||
    !grantTypes.includes("authorization_code") ||
    grantTypes.some(
      (grant) =>
        !(supportedGrantTypes as ReadonlyArray<string>).includes(grant),
    )
  ) {
    return invalidMetadata(
      "grant_types must contain authorization_code and may also contain refresh_token.",
    );
  }

  const responseTypes =
    body.response_types === undefined
      ? (["code"] as const)
      : readStringArray(body.response_types);
  if (
    responseTypes === null ||
    responseTypes.length !== 1 ||
    responseTypes[0] !== "code"
  ) {
    return invalidMetadata("response_types must be exactly [\"code\"].");
  }

  if (
    body.client_name !== undefined &&
    !isBoundedText(body.client_name, mcpClientRegistrationLimits.maxNameLength)
  ) {
    return invalidMetadata(
      `client_name must be text of 1 to ${mcpClientRegistrationLimits.maxNameLength} characters.`,
    );
  }
  if (body.client_uri !== undefined && !isBoundedUri(body.client_uri)) {
    return invalidMetadata("client_uri must be an HTTP or HTTPS URL.");
  }
  if (body.logo_uri !== undefined && !isBoundedUri(body.logo_uri)) {
    return invalidMetadata("logo_uri must be an HTTP or HTTPS URL.");
  }
  if (
    body.software_id !== undefined &&
    !isBoundedText(
      body.software_id,
      mcpClientRegistrationLimits.maxSoftwareFieldLength,
    )
  ) {
    return invalidMetadata("software_id must be short text.");
  }
  if (
    body.software_version !== undefined &&
    !isBoundedText(
      body.software_version,
      mcpClientRegistrationLimits.maxSoftwareFieldLength,
    )
  ) {
    return invalidMetadata("software_version must be short text.");
  }

  let scope: string | null = null;
  if (body.scope !== undefined) {
    const requested =
      typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : null;
    if (
      requested === null ||
      requested.length < 1 ||
      new Set(requested).size !== requested.length ||
      requested.some(
        (item) =>
          !(mcpSupportedScopes as ReadonlyArray<string>).includes(item),
      )
    ) {
      return invalidMetadata(
        `scope must list supported scopes only: ${mcpSupportedScopes.join(" ")}.`,
      );
    }
    scope = requested.join(" ");
  }

  return {
    ok: true,
    metadata: Object.freeze({
      clientName:
        typeof body.client_name === "string"
          ? body.client_name
          : "Unnamed client",
      redirectUris: Object.freeze([...redirectUris]),
      grantTypes: Object.freeze([...grantTypes]),
      responseTypes: Object.freeze(["code" as const]),
      tokenEndpointAuthMethod: "none",
      clientUri: typeof body.client_uri === "string" ? body.client_uri : null,
      logoUri: typeof body.logo_uri === "string" ? body.logo_uri : null,
      softwareId:
        typeof body.software_id === "string" ? body.software_id : null,
      softwareVersion:
        typeof body.software_version === "string"
          ? body.software_version
          : null,
      scope,
    }),
  };
}
