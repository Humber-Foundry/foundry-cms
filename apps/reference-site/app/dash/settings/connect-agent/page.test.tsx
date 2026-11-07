import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settingsAccess: vi.fn(),
  mutationToken: vi.fn(),
  connections: vi.fn(),
  connectionInfo: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  notFound() {
    throw new Error("not_found");
  },
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/src/settings-page-context", () => ({
  requireAuthorizedSettingsAccess: mocks.settingsAccess,
}));
vi.mock("@/src/dashboard-page-context", () => ({
  loadMutationToken: mocks.mutationToken,
}));
vi.mock("@/src/mcp-dashboard-runtime", () => ({
  loadMcpConnectionsForDashboard: mocks.connections,
  loadMcpAgentConnectionInfo: mocks.connectionInfo,
}));

import ConnectAgentPage from "./page";

describe("the Connect an agent screen (#227)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settingsAccess.mockResolvedValue({
      state: "authorized",
      membership: { id: "membership-owner", role: "owner" },
    });
    mocks.mutationToken.mockResolvedValue("token-1");
    mocks.connections.mockResolvedValue([]);
    mocks.connectionInfo.mockResolvedValue({
      resourceUri: "https://site.example/mcp",
      reachableFromOutsideThisMachine: true,
    });
  });

  it("starts with the shared back link to the Connected agents tab, above the heading", async () => {
    const markup = renderToStaticMarkup(await ConnectAgentPage());

    expect(markup).toContain(
      'class="dash-back-link" href="/dash/settings/agents"',
    );
    expect(markup).toContain("Back to Connected agents");
    expect(markup.indexOf("dash-back-link")).toBeLessThan(
      markup.indexOf("<h1"),
    );
  });

  it("ends with a Done button that returns to the Connected agents tab", async () => {
    const markup = renderToStaticMarkup(await ConnectAgentPage());

    const done = markup.lastIndexOf(">Done</a>");
    expect(done).toBeGreaterThan(-1);
    // A real link, so the owner can middle-click it, and it is the last
    // thing on the screen: nothing follows it except the closing tags.
    expect(markup.slice(0, done)).toMatch(
      /<a class="dash-button dash-button-primary" href="\/dash\/settings\/agents"$/u,
    );
    expect(markup.slice(done)).toBe(">Done</a></p></main>");
  });
});
