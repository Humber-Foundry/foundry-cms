import { describe, expect, it } from "vitest";

import {
  mcpConnectionDisplayName,
  mcpRelativeTime,
  mcpScopeDisplay,
} from "./mcp-connection-display";

describe("mcpScopeDisplay", () => {
  it("maps a known scope to its plain phrase", () => {
    expect(mcpScopeDisplay("content.draft")).toEqual({
      scope: "content.draft",
      phrase: "Draft page and post content",
      known: true,
    });
  });

  it("falls back to the raw scope for an unrecognized value", () => {
    expect(mcpScopeDisplay("future.scope")).toEqual({
      scope: "future.scope",
      phrase: "future.scope",
      known: false,
    });
  });
});

describe("mcpConnectionDisplayName", () => {
  it("shows the hostname of a client URL instead of the full raw URL", () => {
    expect(
      mcpConnectionDisplayName("https://client.example/metadata.json"),
    ).toBe("client.example");
  });

  it("falls back to the raw client identifier when it is not a URL", () => {
    expect(mcpConnectionDisplayName("not-a-url")).toBe("not-a-url");
  });
});

describe("mcpRelativeTime", () => {
  const now = new Date("2026-08-01T00:00:00.000Z");

  it("reads a past timestamp as 'ago'", () => {
    expect(mcpRelativeTime("2026-07-29T00:00:00.000Z", now)).toBe(
      "3 days ago",
    );
  });

  it("reads a future timestamp as 'in'", () => {
    expect(mcpRelativeTime("2026-08-01T02:00:00.000Z", now)).toBe(
      "in 2 hours",
    );
  });

  it("reads anything under a minute as 'just now'", () => {
    expect(mcpRelativeTime("2026-08-01T00:00:30.000Z", now)).toBe("just now");
  });
});
