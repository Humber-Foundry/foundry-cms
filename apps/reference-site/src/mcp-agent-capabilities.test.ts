import { mcpSupportedScopes } from "@humber-foundry/application";
import { describe, expect, it } from "vitest";

import {
  mcpAgentCapabilityDescriptions,
  mcpAgentNeverDoes,
} from "./mcp-agent-capabilities";

describe("mcpAgentCapabilityDescriptions", () => {
  it("has one plain sentence for every supported permission", () => {
    for (const scope of mcpSupportedScopes) {
      expect(mcpAgentCapabilityDescriptions[scope]).toBeTruthy();
      expect(mcpAgentCapabilityDescriptions[scope].length).toBeGreaterThan(10);
    }
  });

  it("never promises a capability the tool catalog does not ship yet", () => {
    // The affirmative "can" sentences must never claim these. They are only
    // allowed in `mcpAgentNeverDoes`, which states them as limits.
    const affirmativeText = Object.values(mcpAgentCapabilityDescriptions)
      .join(" ")
      .toLowerCase();
    for (const forbidden of ["upload a photo", "uploads a photo"]) {
      expect(affirmativeText.includes(forbidden)).toBe(false);
    }
  });
});

describe("mcpAgentNeverDoes", () => {
  it("states the newsletter, subscriber and approval limits plainly", () => {
    const text = mcpAgentNeverDoes.join(" ").toLowerCase();
    expect(text).toContain("subscriber list");
    expect(text).toContain("email address");
    expect(text).toContain("approv");
  });

  it("no longer says a page or post is out of reach, because it is not", () => {
    // The page tools (#161) and the blog tools (#171) ship, so a screen that
    // still said an agent cannot make a page or write a post would mislead
    // the owner deciding whether to grant the content draft permission.
    const text = mcpAgentNeverDoes.join(" ").toLowerCase();
    expect(text).not.toContain("cannot create a new page");
    expect(text).not.toContain("blog post from nothing");
  });

  it("no longer claims an agent cannot add a photo", () => {
    // `foundry.media.upload` shipped in #172, so the old sentence would now
    // claim less than an agent can do. The screen says where an added photo
    // stops instead: the photo library and a draft, never the live site
    // without the owner's approval. See ADR-0037.
    const text = mcpAgentNeverDoes.join(" ").toLowerCase();
    expect(text).not.toContain("cannot upload a photo");
    expect(text).toContain("photo library");
    expect(text).toContain("after you approve that draft");
  });

  it("says a live post only comes off the site with the owner's approval", () => {
    // `foundry.blog.archive` starts the removal. The removal itself is an
    // ordinary publication the owner approves, and the screen must say so.
    const text = mcpAgentNeverDoes.join(" ").toLowerCase();
    expect(text).toContain("cannot take a post that is on your site off it");
    expect(text).toContain("you approve that removal");
  });
});
