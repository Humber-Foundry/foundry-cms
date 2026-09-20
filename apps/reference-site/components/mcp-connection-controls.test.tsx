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

    // The full client URL stays available for inspection (as a title
    // attribute), but the plain display name is what the owner reads.
    expect(markup).toContain('title="https://client.example/metadata.json"');
    expect(markup).toContain("client.example");
    expect(markup).toContain('title="https://revoked.example/metadata.json"');
    expect(markup).toContain("revoked.example");
    // The raw scope is replaced by its plain phrase.
    expect(markup).toContain("Read the site");
    expect(markup).not.toContain(">site.read<");
    expect(markup.match(/>Revoke</gu)).toHaveLength(1);
    expect(markup).toContain(">Revoked</span>");
  });

  it("shows an unrecognized scope as its raw string with help text", () => {
    const markup = renderToStaticMarkup(
      <McpConnectionTable
        connections={[connection({ scopes: ["future.scope"] })]}
        pendingId={null}
        onRevoke={() => undefined}
      />,
    );

    expect(markup).toContain("future.scope");
    expect(markup).toContain("Unrecognized permission");
  });

  it("shows a plain empty state with no table when there are no connections", () => {
    const markup = renderToStaticMarkup(
      <McpConnectionTable
        connections={[]}
        pendingId={null}
        onRevoke={() => undefined}
      />,
    );

    // No table at all — not even empty column headers — matches the plain
    // sentence the owner reads instead (#213).
    expect(markup).not.toContain('role="table"');
    expect(markup).not.toContain("CLIENT");
    expect(markup).not.toContain("Permissions");
    expect(markup).toContain("empty-state");
    expect(markup).toMatch(/no agent is connected yet/iu);
    expect(markup).toMatch(/connect an agent/iu);
  });

  it("reads timestamps as relative time instead of an absolute clock string", () => {
    const markup = renderToStaticMarkup(
      <McpConnectionTable
        connections={[
          connection({
            createdAt: "2020-01-01T00:00:00.000Z",
            lastUsedAt: "2020-06-01T00:00:00.000Z",
          }),
        ]}
        pendingId={null}
        onRevoke={() => undefined}
      />,
    );

    expect(markup).toContain("ago");
    expect(markup).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{2,4}/u);
  });
});
