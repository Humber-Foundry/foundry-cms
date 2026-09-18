import { describe, expect, it } from "vitest";

import {
  isValidMcpRedirectUri,
  mcpClientRegistrationLimits,
  readMcpClientRegistration,
} from "./mcp-client-registration";

function request(overrides: Record<string, unknown> = {}) {
  return {
    redirect_uris: ["https://client.example/callback"],
    client_name: "Example client",
    ...overrides,
  };
}

describe("isValidMcpRedirectUri", () => {
  it("accepts https and loopback redirect URIs that real clients use", () => {
    expect(isValidMcpRedirectUri("https://claude.example/callback")).toBe(true);
    expect(isValidMcpRedirectUri("http://localhost:43119/callback")).toBe(true);
    expect(isValidMcpRedirectUri("http://127.0.0.1:43119/callback")).toBe(true);
    expect(isValidMcpRedirectUri("http://[::1]:43119/callback")).toBe(true);
  });

  it("rejects wildcards, fragments, non-loopback http and other schemes", () => {
    expect(isValidMcpRedirectUri("https://*.client.example/callback")).toBe(
      false,
    );
    expect(isValidMcpRedirectUri("https://client.example/cb#fragment")).toBe(
      false,
    );
    expect(isValidMcpRedirectUri("http://client.example/callback")).toBe(false);
    expect(isValidMcpRedirectUri("javascript:alert(1)")).toBe(false);
    expect(isValidMcpRedirectUri("not a url")).toBe(false);
    expect(
      isValidMcpRedirectUri(`https://client.example/${"a".repeat(3_000)}`),
    ).toBe(false);
  });
});

describe("readMcpClientRegistration", () => {
  it("accepts a minimal public-client registration and applies defaults", () => {
    const result = readMcpClientRegistration(request());
    expect(result).toEqual({
      ok: true,
      metadata: {
        clientName: "Example client",
        redirectUris: ["https://client.example/callback"],
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        tokenEndpointAuthMethod: "none",
        clientUri: null,
        logoUri: null,
        softwareId: null,
        softwareVersion: null,
        scope: null,
      },
    });
  });

  it("ignores registration fields it does not use", () => {
    const result = readMcpClientRegistration(
      request({ contacts: ["a@example.com"], unknown_future_field: 12 }),
    );
    expect(result.ok).toBe(true);
  });

  it("names a missing or empty redirect_uris list as invalid_redirect_uri", () => {
    expect(readMcpClientRegistration({ client_name: "x" })).toMatchObject({
      ok: false,
      error: "invalid_redirect_uri",
    });
    expect(
      readMcpClientRegistration(request({ redirect_uris: [] })),
    ).toMatchObject({ ok: false, error: "invalid_redirect_uri" });
  });

  it("rejects a redirect URI that is not exactly matchable", () => {
    expect(
      readMcpClientRegistration(
        request({ redirect_uris: ["https://client.example/cb", "http://evil.example/cb"] }),
      ),
    ).toMatchObject({ ok: false, error: "invalid_redirect_uri" });
  });

  it("bounds the number of redirect URIs", () => {
    const many = Array.from(
      { length: mcpClientRegistrationLimits.maxRedirectUris + 1 },
      (_, index) => `https://client.example/callback-${index}`,
    );
    expect(
      readMcpClientRegistration(request({ redirect_uris: many })),
    ).toMatchObject({ ok: false, error: "invalid_redirect_uri" });
  });

  it("rejects a confidential client, an unsupported grant and an unsupported response type", () => {
    expect(
      readMcpClientRegistration(
        request({ token_endpoint_auth_method: "client_secret_basic" }),
      ),
    ).toMatchObject({ ok: false, error: "invalid_client_metadata" });
    expect(
      readMcpClientRegistration(request({ grant_types: ["implicit"] })),
    ).toMatchObject({ ok: false, error: "invalid_client_metadata" });
    expect(
      readMcpClientRegistration(request({ response_types: ["token"] })),
    ).toMatchObject({ ok: false, error: "invalid_client_metadata" });
  });

  it("accepts the authorization_code grant on its own", () => {
    const result = readMcpClientRegistration(
      request({ grant_types: ["authorization_code"], response_types: ["code"] }),
    );
    expect(result).toMatchObject({
      ok: true,
      metadata: { grantTypes: ["authorization_code"] },
    });
  });

  it("bounds the client name and keeps it as untrusted text", () => {
    expect(
      readMcpClientRegistration(
        request({
          client_name: "a".repeat(mcpClientRegistrationLimits.maxNameLength + 1),
        }),
      ),
    ).toMatchObject({ ok: false, error: "invalid_client_metadata" });
    expect(
      readMcpClientRegistration(
        request({ client_name: "<script>alert(1)</script>" }),
      ),
    ).toMatchObject({
      ok: true,
      metadata: { clientName: "<script>alert(1)</script>" },
    });
  });

  it("defaults the client name when the request omits it", () => {
    const result = readMcpClientRegistration({
      redirect_uris: ["https://client.example/callback"],
    });
    expect(result).toMatchObject({
      ok: true,
      metadata: { clientName: "Unnamed client" },
    });
  });

  it("rejects a scope request outside the supported scopes", () => {
    expect(
      readMcpClientRegistration(request({ scope: "site.read admin.everything" })),
    ).toMatchObject({ ok: false, error: "invalid_client_metadata" });
    expect(
      readMcpClientRegistration(request({ scope: "site.read content.draft" })),
    ).toMatchObject({ ok: true, metadata: { scope: "site.read content.draft" } });
  });

  it("rejects a body that is not a JSON object", () => {
    expect(readMcpClientRegistration([])).toMatchObject({
      ok: false,
      error: "invalid_client_metadata",
    });
    expect(readMcpClientRegistration("{}")).toMatchObject({
      ok: false,
      error: "invalid_client_metadata",
    });
  });
});
