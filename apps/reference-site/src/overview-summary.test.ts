import { describe, expect, it } from "vitest";

import type {
  AnalyticsOverviewView,
  AnalyticsReading,
  AnalyticsValue,
  ContentPublicationHistoryEntry,
} from "@humber-foundry/application";

import {
  messagesOverviewNumber,
  overviewActivityLimit,
  pagesOverviewNumber,
  publicSiteAddress,
  recentSiteActivity,
  subscribersOverviewNumber,
  visitsOverviewNumber,
} from "./overview-summary";

function reading(
  value: AnalyticsValue,
  comparabilitySignature = "one",
): AnalyticsReading {
  return {
    metricKey: "web.visits",
    definition: "One arrival from somewhere else.",
    unit: "count",
    prominence: "primary",
    aggregation: "sum",
    subjectType: "site",
    subjectId: null,
    source: "analytics_engine",
    sourceName: "site counter",
    sourceMetric: "visits",
    definitionVersion: 1,
    quality: "exact",
    sampleInterval: null,
    observedAt: null,
    completeThrough: null,
    freshness: "fresh",
    value,
    measuredBuckets: 30,
    unavailableBuckets: 0,
    comparabilitySignature,
  } as AnalyticsReading;
}

function overviewWith(
  metrics: ReadonlyArray<AnalyticsReading>,
): AnalyticsOverviewView {
  return { metrics, referrers: [] } as unknown as AnalyticsOverviewView;
}

describe("visitsOverviewNumber", () => {
  it("names the period and links to Visitors for that same period", () => {
    const number = visitsOverviewNumber(
      overviewWith([reading({ state: "available", value: 1234 })]),
      30,
    );

    expect(number.label).toBe("Visits in the last 30 days");
    expect(number.href).toBe("/dash/analytics?days=30");
    expect(number.value).toBe("1,234");
    expect(number.note).toBeNull();
  });

  it("shows no figure and says why when the read model cannot answer", () => {
    const number = visitsOverviewNumber(null, 30);

    expect(number.value).toBeNull();
    expect(number.note).toContain("visit counter");
  });

  it("shows no figure when the counter reported nothing for the period", () => {
    const number = visitsOverviewNumber(overviewWith([]), 30);

    expect(number.value).toBeNull();
    expect(number.note).toContain("reported nothing");
  });

  it("shows no figure when a reading is unavailable", () => {
    const number = visitsOverviewNumber(
      overviewWith([
        reading({ state: "unavailable", reason: "source_unavailable" }),
      ]),
      7,
    );

    expect(number.value).toBeNull();
    expect(number.note).toContain("has not reported");
  });

  it("never adds two counts of the same thing together", () => {
    const number = visitsOverviewNumber(
      overviewWith([
        reading({ state: "available", value: 100 }, "one"),
        reading({ state: "available", value: 80 }, "two"),
      ]),
      30,
    );

    expect(number.value).toBeNull();
    expect(number.note).toContain("never added together");
    expect(number.note).not.toContain("180");
  });

  it("writes a figure too small to report exactly in words", () => {
    const number = visitsOverviewNumber(
      overviewWith([reading({ state: "suppressed", label: "fewer than 5" })]),
      30,
    );

    expect(number.value).toBe("fewer than 5");
    expect(number.note).toBeNull();
  });
});

describe("the other key numbers", () => {
  it("counts unread messages and links to Messages", () => {
    const number = messagesOverviewNumber(3);

    expect(number.value).toBe("3");
    expect(number.href).toBe("/dash/forms");
  });

  it("says why there is no message figure rather than showing a zero", () => {
    const number = messagesOverviewNumber(null);

    expect(number.value).toBeNull();
    expect(number.note).toContain("message store");
  });

  it("names the screen that holds every figure it cannot show", () => {
    expect(visitsOverviewNumber(null, 30).note).toContain("Visitors");
    expect(visitsOverviewNumber(overviewWith([]), 30).note).toContain(
      "Visitors",
    );
    expect(messagesOverviewNumber(null).note).toContain("Messages");
    expect(subscribersOverviewNumber(null).note).toContain("Subscribers");
  });

  it("counts people on the list and links to Subscribers", () => {
    expect(subscribersOverviewNumber(12).value).toBe("12");
    expect(subscribersOverviewNumber(12).href).toBe("/dash/subscribers");
    expect(subscribersOverviewNumber(null).value).toBeNull();
  });

  it("counts published pages and links to Pages", () => {
    const number = pagesOverviewNumber(4);

    expect(number.value).toBe("4");
    expect(number.href).toBe("/dash/pages");
    expect(number.note).toBeNull();
  });
});

describe("publicSiteAddress", () => {
  it("reads the address a reader types out of the site's own origin", () => {
    expect(publicSiteAddress("https://example.test")).toBe("example.test");
    expect(publicSiteAddress("https://example.test:8443/x")).toBe(
      "example.test:8443",
    );
  });

  it("gives nothing rather than a broken address", () => {
    expect(publicSiteAddress("")).toBeNull();
    expect(publicSiteAddress("not a web address")).toBeNull();
  });
});

function publication(
  id: string,
  status: ContentPublicationHistoryEntry["publication"]["status"],
  updatedAt: string,
): ContentPublicationHistoryEntry {
  return {
    publication: { id, status, updatedAt },
  } as unknown as ContentPublicationHistoryEntry;
}

describe("recentSiteActivity", () => {
  const editorHref = "/dash/pages?workspace=w1&page=page_home";
  const formatMoment = (value: string) => `on ${value}`;

  it("puts the newest thing first and holds at most five lines", () => {
    const items = recentSiteActivity({
      publications: [
        publication("p1", "verified-live", "2026-09-01T00:00:00.000Z"),
        publication("p2", "verified-live", "2026-09-02T00:00:00.000Z"),
        publication("p3", "failed", "2026-09-03T00:00:00.000Z"),
        publication("p4", "verified-live", "2026-09-04T00:00:00.000Z"),
        publication("p5", "verified-live", "2026-09-05T00:00:00.000Z"),
        publication("p6", "verified-live", "2026-09-06T00:00:00.000Z"),
      ],
      draftSavedAt: "2026-09-07T00:00:00.000Z",
      draftRevision: 2,
      editorHref,
      formatMoment,
    });

    expect(items).toHaveLength(overviewActivityLimit);
    expect(items[0].label).toBe("Your draft was saved");
    expect(items[1].key).toBe("publication-p6");
    expect(items[0].time).toBe("on 2026-09-07T00:00:00.000Z");
    // The save opens the editor; a publish opens the editor at the panel
    // that keeps the record of every publish.
    expect(items[0].href).toBe(editorHref);
    expect(items[1].href).toBe(
      `${editorHref}#publication-history-heading`,
    );
  });

  it("leaves out the save when the draft has never been changed", () => {
    const items = recentSiteActivity({
      publications: [],
      draftSavedAt: "2026-09-07T00:00:00.000Z",
      draftRevision: 0,
      editorHref,
      formatMoment,
    });

    expect(items).toEqual([]);
  });

  it("says plainly when a publish stopped and when one is still running", () => {
    const items = recentSiteActivity({
      publications: [
        publication("p1", "blocked", "2026-09-02T00:00:00.000Z"),
        publication("p2", "building", "2026-09-03T00:00:00.000Z"),
      ],
      draftSavedAt: "2026-09-01T00:00:00.000Z",
      draftRevision: 0,
      editorHref,
      formatMoment,
    });

    expect(items[0].label).toBe("A publish is still running");
    expect(items[1].label).toBe(
      "A publish stopped before anything went live",
    );
  });

  it("does not call a publish with an unknown outcome running", () => {
    const items = recentSiteActivity({
      publications: [publication("p1", "unknown", "2026-09-02T00:00:00.000Z")],
      draftSavedAt: "2026-09-01T00:00:00.000Z",
      draftRevision: 0,
      editorHref,
      formatMoment,
    });

    expect(items[0].label).toBe(
      "What happened to a publish is still being checked",
    );
  });
});
