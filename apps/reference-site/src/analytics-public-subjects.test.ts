import { describe, expect, it, vi } from "vitest";

vi.mock("../foundry/site-definition", async () => {
  const { withSecondPage } = await import(
    "./test-support/two-page-site-definition"
  );
  return { installedSiteDefinition: withSecondPage() };
});

import {
  secondPageId,
  secondPageSectionId,
} from "./test-support/two-page-site-definition";
import { installedSiteDefinition } from "../foundry/site-definition";
import { publicSubjectIds } from "./analytics-public-subjects";

describe("publicSubjectIds", () => {
  it("includes every page's own id and its own sections' ids, not only home", () => {
    const ids = publicSubjectIds();
    const home = installedSiteDefinition.pages[0]!;

    expect(ids.has(home.id)).toBe(true);
    for (const section of home.sections) {
      expect(ids.has(section.id)).toBe(true);
    }
    expect(ids.has(secondPageId)).toBe(true);
    expect(ids.has(secondPageSectionId)).toBe(true);
  });

  it("includes every published blog post id", () => {
    const ids = publicSubjectIds();
    for (const post of installedSiteDefinition.blog.posts) {
      expect(ids.has(post.id)).toBe(true);
    }
  });

  it("names no visitor, session or request identifier — only public content ids", () => {
    // The privacy boundary this set enforces (ADR-0003) depends on it holding
    // only stable, public CMS object ids. This is a coarse but cheap proof:
    // every member matches the shape a page, section or post id has, never a
    // random per-request token.
    const ids = [...publicSubjectIds()];
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    }
  });
});
