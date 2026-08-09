import { afterEach, describe, expect, it } from "vitest";

import {
  hashPublishedSiteDefinition,
} from "@humber-foundry/application";
import { referenceSiteDefinition } from "@humber-foundry/site-definition";

import { GET } from "./route";

describe("Foundry release marker", () => {
  const original = process.env.FOUNDRY_RELEASE_COMMIT_SHA;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.FOUNDRY_RELEASE_COMMIT_SHA;
    } else {
      process.env.FOUNDRY_RELEASE_COMMIT_SHA = original;
    }
  });

  it("exposes the exact build commit, published content hash, and schema", async () => {
    process.env.FOUNDRY_RELEASE_COMMIT_SHA = "a".repeat(40);
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("must-revalidate");
    await expect(response.json()).resolves.toEqual({
      commitSha: "a".repeat(40),
      contentHash: await hashPublishedSiteDefinition(
        referenceSiteDefinition,
      ),
      schemaVersion: referenceSiteDefinition.schemaVersion,
    });
  });

  it("fails closed when the build did not provide a Git commit", async () => {
    delete process.env.FOUNDRY_RELEASE_COMMIT_SHA;
    const response = await GET();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
