import { describe, expect, it } from "vitest";

import {
  HumanAccessConfigurationError,
} from "./human-access-configuration";
import {
  isMcpProductionRequest,
  readMcpRegisteredClients,
} from "./mcp-production-runtime";

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

  it("claims only the public resource, protected owner actions, and OAuth metadata", () => {
    for (const path of [
      "/api/foundry-mcp",
      "/api/foundry-mcp/oauth/token",
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
