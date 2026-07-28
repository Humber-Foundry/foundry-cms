import { describe, expect, it } from "vitest";

import {
  cropForOccurrence,
  cropForSelectedRevision,
  mediaOccurrenceMutationsEnabled,
} from "./media-manager-state";

describe("media manager crop state", () => {
  it("loads the persisted crop for the selected occurrence", () => {
    expect(
      cropForOccurrence(
        [
          {
            occurrenceId: "occurrence_home_hero",
            crop: { x: 0.1, y: 0.2, width: 0.6, height: 0.5 },
          },
        ],
        "occurrence_home_hero",
      ),
    ).toEqual({ x: 0.1, y: 0.2, width: 0.6, height: 0.5 });
  });

  it("uses a full-frame crop for an unbound occurrence", () => {
    expect(cropForOccurrence([], "occurrence_home_detail")).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });

  it("ignores a delayed revision for an occurrence that is no longer selected", () => {
    expect(
      cropForSelectedRevision("occurrence_home_detail", {
        occurrenceId: "occurrence_home_hero",
        crop: null,
      }),
    ).toBeUndefined();
  });

  it("disables occurrence mutations when the content workspace is stale", () => {
    expect(mediaOccurrenceMutationsEnabled(true, { revision: 3 })).toBe(false);
    expect(mediaOccurrenceMutationsEnabled(false, { revision: 3 })).toBe(true);
    expect(mediaOccurrenceMutationsEnabled(false, undefined)).toBe(false);
  });
});
