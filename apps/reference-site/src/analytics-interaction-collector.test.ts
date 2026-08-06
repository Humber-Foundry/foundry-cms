import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  collectInteraction,
  writeInteractionPoint,
  type AnalyticsEngineDataset,
} from "./analytics-interaction-collector";

const publicSubjectIds = new Set(["cta_book", "content_home"]);

describe("collecting an anonymous interaction", () => {
  it("accepts a declared kind against a published object", () => {
    expect(
      collectInteraction({
        payload: { kind: "cta_activation", subjectId: "cta_book" },
        publicSubjectIds,
      }),
    ).toEqual({
      outcome: "accepted",
      point: { kind: "cta_activation", subjectId: "cta_book" },
    });
  });

  it("refuses an event kind nobody declared", () => {
    expect(
      collectInteraction({
        payload: { kind: "page_scroll", subjectId: "cta_book" },
        publicSubjectIds,
      }),
    ).toEqual({ outcome: "rejected", code: "event_kind_not_allowed" });
  });

  it("refuses a subject that is not a published object", () => {
    expect(
      collectInteraction({
        payload: { kind: "cta_activation", subjectId: "cta_unknown" },
        publicSubjectIds,
      }),
    ).toEqual({ outcome: "rejected", code: "subject_not_public" });
  });

  it("refuses a payload that is not the declared shape", () => {
    expect(
      collectInteraction({ payload: "cta_book", publicSubjectIds }),
    ).toEqual({ outcome: "rejected", code: "payload_invalid" });
  });

  it("discards every field beyond the two it declares", () => {
    const result = collectInteraction({
      payload: {
        kind: "cta_activation",
        subjectId: "cta_book",
        visitorId: "v1",
        referrer: "https://example.com/pricing?utm_source=news",
      },
      publicSubjectIds,
    });

    expect(result).toEqual({
      outcome: "accepted",
      point: { kind: "cta_activation", subjectId: "cta_book" },
    });
  });
});

describe("writing an interaction point", () => {
  it("writes only the event kind and the public object ID", () => {
    const written: unknown[] = [];
    const dataset: AnalyticsEngineDataset = {
      writeDataPoint(point) {
        written.push(point);
      },
    };

    writeInteractionPoint(dataset, {
      kind: "form_impression",
      subjectId: "form_contact",
    });

    expect(written).toEqual([
      { blobs: ["form_impression", "form_contact"], doubles: [1] },
    ]);
  });
});
