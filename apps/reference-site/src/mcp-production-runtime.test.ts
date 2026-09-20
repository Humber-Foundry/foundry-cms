import { describe, expect, it } from "vitest";

import {
  HumanAccessConfigurationError,
} from "./human-access-configuration";
import {
  checkMcpAccessBoundary,
  isMcpProductionRequest,
  mcpAccessBoundary,
  mcpMediaAssetId,
  readMcpRegisteredClients,
} from "./mcp-production-runtime";

import type { McpConnectionPrincipal } from "@humber-foundry/application";
import type { SiteId } from "@humber-foundry/site-definition";

function mediaPrincipal(
  overrides: Partial<McpConnectionPrincipal> = {},
): McpConnectionPrincipal {
  return {
    connectionId: "connection-media",
    actorId: "actor-media",
    clientId: "https://client.example/media.json",
    siteId: "site_media" as SiteId,
    scopes: ["site.read", "content.draft"],
    ...overrides,
  };
}

describe("the photo id an upload mints", () => {
  it("mints the same id for a retry and a different one for anyone else", async () => {
    const key = "11111111-1111-4111-8111-111111111111";
    const first = await mcpMediaAssetId(mediaPrincipal(), key);
    // A retry after an unknown result mints the same id, so the site keeps
    // one photo rather than two. See ADR-0037.
    expect(await mcpMediaAssetId(mediaPrincipal(), key)).toBe(first);
    expect(first).toMatch(/^asset_[0-9a-f]{32}$/u);

    // A different connection, a different site, or a different retry key all
    // mint a different id, so no agent can reach an id another actor holds.
    expect(
      await mcpMediaAssetId(mediaPrincipal({ actorId: "actor-other" }), key),
    ).not.toBe(first);
    expect(
      await mcpMediaAssetId(
        mediaPrincipal({ siteId: "site_other" as SiteId }),
        key,
      ),
    ).not.toBe(first);
    expect(
      await mcpMediaAssetId(
        mediaPrincipal(),
        "22222222-2222-4222-8222-222222222222",
      ),
    ).not.toBe(first);
  });
});

describe("production MCP configuration", () => {
  it("accepts only explicit clients with exact secure or loopback redirects", () => {
    expect(
      readMcpRegisteredClients(
        JSON.stringify({
          "https://client.example/metadata.json": {
            name: "Desktop client",
            redirectUris: [
              "https://client.example/callback",
              "http://127.0.0.1:43119/callback",
            ],
          },
        }),
      ),
    ).toEqual({
      "https://client.example/metadata.json": {
        name: "Desktop client",
        redirectUris: [
          "https://client.example/callback",
          "http://127.0.0.1:43119/callback",
        ],
      },
    });
  });

  it.each([
    ["empty registry", "{}"],
    [
      "wildcard redirect",
      JSON.stringify({
        "https://client.example/metadata.json": {
          name: "Unsafe",
          redirectUris: ["https://client.example/*"],
        },
      }),
    ],
    [
      "insecure remote redirect",
      JSON.stringify({
        "https://client.example/metadata.json": {
          name: "Unsafe",
          redirectUris: ["http://client.example/callback"],
        },
      }),
    ],
    [
      "fragment redirect",
      JSON.stringify({
        "https://client.example/metadata.json": {
          name: "Unsafe",
          redirectUris: ["https://client.example/callback#token"],
        },
      }),
    ],
  ])("fails closed for %s", (_label, value) => {
    expect(() => readMcpRegisteredClients(value)).toThrow(
      HumanAccessConfigurationError,
    );
  });

  it("keeps the operator allowlist on literal loopback addresses only", () => {
    // A dynamically registered client may use the localhost name, because
    // that is what installed clients document. An operator writes the
    // allowlist by hand and must write the literal address.
    expect(() =>
      readMcpRegisteredClients(
        JSON.stringify({
          "https://client.example/metadata.json": {
            name: "Desktop client",
            redirectUris: ["http://localhost:43119/callback"],
          },
        }),
      ),
    ).toThrow(HumanAccessConfigurationError);
  });

  it("treats an unset client allowlist as open dynamic registration", () => {
    expect(readMcpRegisteredClients(undefined)).toEqual({});
    expect(readMcpRegisteredClients("")).toEqual({});
    expect(readMcpRegisteredClients("   ")).toEqual({});
  });

  it("names every MCP path on one side of the Cloudflare Access boundary", () => {
    // Client paths must be reachable with no Access session, because a client
    // calls them with no human present.
    expect(mcpAccessBoundary.public).toEqual([
      "/.well-known/oauth-protected-resource/api/foundry-mcp",
      "/.well-known/oauth-authorization-server",
      "/api/foundry-mcp/oauth/register",
      "/api/foundry-mcp/oauth/token",
      "/api/foundry-mcp",
    ]);
    // Owner consent and revocation are human decisions and stay protected.
    expect(mcpAccessBoundary.ownerProtected).toEqual([
      "/api/foundry-cms/mcp/oauth/authorize",
      "/api/foundry-cms/mcp-connections/revoke",
    ]);
    for (const path of mcpAccessBoundary.public) {
      expect(path.startsWith("/api/foundry-cms/")).toBe(false);
    }
    expect(checkMcpAccessBoundary()).toEqual({
      ok: true,
      unroutedPaths: [],
      undocumentedPaths: [],
    });
  });

  it("claims only the public resource, protected owner actions, and OAuth metadata", () => {
    for (const path of [
      "/api/foundry-mcp",
      "/api/foundry-mcp/oauth/token",
      "/api/foundry-mcp/oauth/register",
      "/api/foundry-cms/mcp/oauth/authorize",
      "/api/foundry-cms/mcp-connections/revoke",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource/api/foundry-mcp",
    ]) {
      expect(
        isMcpProductionRequest(new Request(`https://foundry.example${path}`)),
      ).toBe(true);
    }
    expect(
      isMcpProductionRequest(
        new Request("https://foundry.example/api/foundry-cms/content"),
      ),
    ).toBe(false);
  });
});
