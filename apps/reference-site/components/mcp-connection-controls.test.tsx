import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { McpConnectionSummary } from "@humber-foundry/application";
import { referenceSiteDefinition } from "@humber-foundry/site-definition";

import { McpConnectionTable } from "./mcp-connection-controls";

function connection(
  overrides: Partial<McpConnectionSummary>,
): McpConnectionSummary {
  return {
    connectionId: "11111111-1111-4111-8111-111111111111",
    actorId: "22222222-2222-4222-8222-222222222222",
    clientId: "https://client.example/metadata.json",
    siteId: referenceSiteDefinition.site.id,
    scopes: ["site.read"],
    status: "active",
    createdAt: "2026-07-29T18:00:00.000Z",
    revokedAt: null,
    lastUsedAt: null,
    ...overrides,
  };
}

describe("Owner MCP connection inventory", () => {
  it("shows each durable connection and only offers revoke for active rows", () => {
    const markup = renderToStaticMarkup(
      <McpConnectionTable
        connections={[
          connection({}),
          connection({
            connectionId: "33333333-3333-4333-8333-333333333333",
            clientId: "https://revoked.example/metadata.json",
            status: "revoked",
            revokedAt: "2026-07-29T18:05:00.000Z",
          }),
        ]}
        pendingId={null}
        onRevoke={() => undefined}
      />,
    );

    expect(markup).toContain("https://client.example/metadata.json");
    expect(markup).toContain("https://revoked.example/metadata.json");
    expect(markup).toContain("site.read");
    expect(markup.match(/>Revoke</gu)).toHaveLength(1);
    expect(markup).toContain(">Revoked</span>");
  });
});
