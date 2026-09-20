import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../foundry/site-definition", () => ({
  installedSiteDefinition: { site: { id: "site_reference_installation" } },
}));

const cloudflareEnvironment = vi.hoisted(() => ({ current: {} as any }));

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: cloudflareEnvironment.current })),
}));

import { loadMcpAgentConnectionInfo } from "./mcp-dashboard-runtime";

afterEach(() => {
  vi.unstubAllEnvs();
  cloudflareEnvironment.current = {};
});

describe("loadMcpAgentConnectionInfo", () => {
  it("builds the agent address from the real configured origin", async () => {
    vi.stubEnv("NODE_ENV", "production");
    cloudflareEnvironment.current = {
      FOUNDRY_CANONICAL_ORIGIN: "https://cms.example.com",
    };
    const info = await loadMcpAgentConnectionInfo();
    expect(info).toEqual({
      resourceUri: "https://cms.example.com/api/foundry-mcp",
      reachableFromOutsideThisMachine: true,
    });
  });

  it("reports local development as not reachable from outside this machine", async () => {
    vi.stubEnv("NODE_ENV", "development");
    // Local development builds its own environment and never calls
    // getCloudflareContext; it defaults to the private preview origin.
    const info = await loadMcpAgentConnectionInfo();
    expect(info).toEqual({
      resourceUri: "http://localhost:3000/api/foundry-mcp",
      reachableFromOutsideThisMachine: false,
    });
  });

  it("reports a private preview tunnel origin as not reachable, even over HTTPS", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("FOUNDRY_PRIVATE_PREVIEW_ORIGIN", "https://preview.trycloudflare.com");
    const info = await loadMcpAgentConnectionInfo();
    expect(info).toEqual({
      resourceUri: "https://preview.trycloudflare.com/api/foundry-mcp",
      reachableFromOutsideThisMachine: false,
    });
  });

  it("reports a non-HTTPS production origin as not reachable", async () => {
    vi.stubEnv("NODE_ENV", "production");
    cloudflareEnvironment.current = {
      FOUNDRY_CANONICAL_ORIGIN: "http://internal.example",
    };
    const info = await loadMcpAgentConnectionInfo();
    expect(info.reachableFromOutsideThisMachine).toBe(false);
  });

  it("reports no address when the installation has not set its origin", async () => {
    vi.stubEnv("NODE_ENV", "production");
    cloudflareEnvironment.current = {};
    const info = await loadMcpAgentConnectionInfo();
    expect(info).toEqual({
      resourceUri: null,
      reachableFromOutsideThisMachine: false,
    });
  });
});
