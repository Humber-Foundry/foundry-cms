import { describe, expect, it } from "vitest";

import type { ContentRevision } from "@foundry/application";

import { newestContentRevision } from "./workspace-revision";

describe("workspace revision head", () => {
  it("does not regress when an older response arrives last", () => {
    const newer = { revision: 3 } as ContentRevision;
    const older = { revision: 2 } as ContentRevision;

    expect(newestContentRevision(newer, older)).toBe(newer);
    expect(newestContentRevision(older, newer)).toBe(newer);
  });
});
