import { describe, expect, it } from "vitest";

import { mcpPreviewReviewUrl } from "./content-revision-links";

describe("MCP preview review links", () => {
  it("returns an absolute same-origin URL for remote clients", () => {
    expect(
      mcpPreviewReviewUrl(
        "https://cms.example.com",
        "preview/with spaces",
      ),
    ).toBe(
      "https://cms.example.com/dash/review/preview%2Fwith%20spaces",
    );
  });
});
