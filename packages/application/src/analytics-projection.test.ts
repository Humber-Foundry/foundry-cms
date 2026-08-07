import { beforeEach, describe, expect, it } from "vitest";

import { createSiteId } from "@foundry/site-definition";

import {
  AnalyticsPrivacyViolationError,
  AnalyticsVocabularyError,
  type AnalyticsSourceState,
} from "./analytics-model";
import {
  analyticsFactKey,
  AnalyticsProjectionError,
  createAnalyticsProjection,
  type AnalyticsFactRevisionRecord,
  type AnalyticsProjectionStore,
  type StoredAnalyticsFact,
} from "./analytics-projection";

const siteId = createSiteId("site_reference");

function createStore() {
  const facts = new Map<string, StoredAnalyticsFact>();
  const revisions: AnalyticsFactRevisionRecord[] = [];
  const sourceStates = new Map<string, AnalyticsSourceState>();
  let commits = 0;
  let failNextCommit = false;

  const store: AnalyticsProjectionStore = {
    async findCurrentSourceState({ source, sourceName }) {
      return sourceStates.get(`${source}|${sourceName}`) ?? null;
    },
    async findFacts(identities) {
      return identities.flatMap((identity) => {
        const fact = facts.get(analyticsFactKey(identity));
        return fact === undefined ? [] : [fact];
      });
    },
    async commitProjection(input) {
      if (failNextCommit) {
        failNextCommit = false;
        throw new Error("d1_unavailable");
      }
      commits += 1;
      for (const fact of input.facts) {
        facts.set(analyticsFactKey(fact), fact);
      }
      revisions.push(...input.revisions);
      sourceStates.set(
        `${input.sourceState.source}|${input.sourceState.sourceName}`,
        input.sourceState,
      );
    },
    async listFactsForCompaction() {
      return [...facts.values()].filter(
        (fact) => fact.granularity === "hour",
      );
    },
    async commitCompaction(input) {
      commits += 1;
      for (const fact of input.removedFacts) {
        facts.delete(analyticsFactKey(fact));
      }
      for (const fact of input.dailyFacts) {
        facts.set(analyticsFactKey(fact), fact);
      }
    },
    async purgeExpiredFacts({ before }) {
      let factsRemoved = 0;
      for (const [key, fact] of facts) {
        if (Date.parse(fact.bucketEndUtc) <= Date.parse(before)) {
          facts.delete(key);
          factsRemoved += 1;
        }
      }
      const remaining = revisions.filter(
        (entry) => Date.parse(entry.bucketStartUtc) >= Date.parse(before),
      );
      const revisionsRemoved = revisions.length - remaining.length;
      revisions.splice(0, revisions.length, ...remaining);
      return { factsRemoved, revisionsRemoved };
    },
  };

  return {
    store,
    facts,
    revisions,
    sourceStates,
    commitCount: () => commits,
    failNextCommit() {
      failNextCommit = true;
    },
  };
}

function webFact(overrides: Record<string, unknown> = {}) {
  return {
    metricKey: "web.page_views" as const,
    bucketStartUtc: "2026-08-01T00:00:00.000Z",
    bucketEndUtc: "2026-08-02T00:00:00.000Z",
    granularity: "day" as const,
    subjectType: "site" as const,
    subjectId: "site_reference",
    dimension: { key: "", value: "" },
    unit: "count" as const,
    quality: "estimated" as const,
    sampleInterval: 1,
    value: 120,
    unavailableReason: null,
    ...overrides,
  };
}

function runInput(overrides: Record<string, unknown> = {}) {
  return {
    source: "cloudflare_web" as const,
    sourceName: "cloudflare",
    sourceMetric: "pageViews",
    definitionVersion: 1,
    revision: 1,
    observedAt: "2026-08-02T01:00:00.000Z",
    completeThrough: "2026-08-02T00:00:00.000Z",
    expectedLagSeconds: 3_600,
    facts: [webFact()],
    ...overrides,
  };
}

let harness: ReturnType<typeof createStore>;

function projection(now = "2026-08-02T01:05:00.000Z") {
  return createAnalyticsProjection({
    siteId,
    store: harness.store,
    now: () => now,
  });
}

beforeEach(() => {
  harness = createStore();
});

describe("normalizing a source run into the projection", () => {
  it("stores one canonical fact per measurement", async () => {
    await projection().project(runInput());

    const stored = [...harness.facts.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      siteId,
      metricKey: "web.page_views",
      source: "cloudflare_web",
      sourceName: "cloudflare",
      sourceMetric: "pageViews",
      definitionVersion: 1,
      quality: "estimated",
      availability: "available",
      value: 120,
      revision: 1,
      observedAt: "2026-08-02T01:00:00.000Z",
      completeThrough: "2026-08-02T00:00:00.000Z",
    });
  });

  it("records the source as healthy through the reported instant", async () => {
    await projection().project(runInput());

    expect(harness.sourceStates.get("cloudflare_web|cloudflare")).toMatchObject(
      {
        status: "healthy",
        completeThrough: "2026-08-02T00:00:00.000Z",
        lastSuccessAt: "2026-08-02T01:00:00.000Z",
        errorCode: null,
      },
    );
  });
});

describe("the guards on a projection run", () => {
  it("refuses a payload carrying a person-level field", async () => {
    await expect(
      projection().project(
        runInput({
          facts: [webFact({ subjectId: "site_reference", visitorId: "v1" })],
        }),
      ),
    ).rejects.toThrow(AnalyticsPrivacyViolationError);
    expect(harness.commitCount()).toBe(0);
  });

  it("refuses a metric outside the canonical vocabulary", async () => {
    await expect(
      projection().project(
        runInput({ facts: [webFact({ metricKey: "web.unique_visitors" })] }),
      ),
    ).rejects.toThrow(AnalyticsVocabularyError);
    expect(harness.commitCount()).toBe(0);
  });

  it("refuses a dimension outside the allowlist", async () => {
    await expect(
      projection().project(
        runInput({
          facts: [webFact({ dimension: { key: "country", value: "CA" } })],
        }),
      ),
    ).rejects.toThrow(AnalyticsProjectionError);
    expect(harness.commitCount()).toBe(0);
  });

  it("refuses a subject type the metric does not describe", async () => {
    await expect(
      projection().project(
        runInput({
          facts: [webFact({ subjectType: "campaign", subjectId: "c1" })],
        }),
      ),
    ).rejects.toThrow(AnalyticsProjectionError);
  });

  it("refuses a unit the registry does not declare", async () => {
    await expect(
      projection().project(
        runInput({ facts: [webFact({ unit: "ratio" })] }),
      ),
    ).rejects.toThrow(AnalyticsProjectionError);
  });

  it("refuses a source that does not own the metric", async () => {
    await expect(
      projection().project(
        runInput({
          source: "provider",
          sourceName: "brevo",
          facts: [webFact()],
        }),
      ),
    ).rejects.toThrow(AnalyticsProjectionError);
  });

  it("refuses a missing value that gives no reason", async () => {
    await expect(
      projection().project(
        runInput({
          facts: [webFact({ value: null, unavailableReason: null })],
        }),
      ),
    ).rejects.toThrow(AnalyticsProjectionError);
  });

  it("refuses a negative count", async () => {
    await expect(
      projection().project(runInput({ facts: [webFact({ value: -1 })] })),
    ).rejects.toThrow(AnalyticsProjectionError);
  });
});

describe("missing measurements", () => {
  it("stores an omitted provider metric with an unavailable state", async () => {
    await projection().project(
      runInput({
        source: "provider",
        sourceName: "brevo",
        sourceMetric: "uniqueClicks",
        facts: [
          webFact({
            metricKey: "campaign.unique_clicks_reported",
            subjectType: "campaign",
            subjectId: "campaign_1",
            granularity: "campaign",
            quality: "directional",
            value: null,
            unavailableReason: "provider_omitted",
          }),
        ],
      }),
    );

    const stored = [...harness.facts.values()][0];
    expect(stored).toMatchObject({
      availability: "unavailable",
      value: null,
      unavailableReason: "provider_omitted",
    });
  });
});

describe("revisions and late data", () => {
  it("replaces a value when a newer revision arrives", async () => {
    await projection().project(runInput());
    await projection().project(
      runInput({ revision: 2, facts: [webFact({ value: 131 })] }),
    );

    expect([...harness.facts.values()][0]).toMatchObject({
      value: 131,
      revision: 2,
    });
  });

  it("adds a revision audit entry for a material change", async () => {
    await projection().project(runInput());
    await projection().project(
      runInput({ revision: 2, facts: [webFact({ value: 131 })] }),
    );

    expect(harness.revisions).toHaveLength(1);
    expect(harness.revisions[0]).toMatchObject({
      previousRevision: 1,
      previousValue: 120,
      nextRevision: 2,
      nextValue: 131,
    });
  });

  it("does not audit a re-projection that changes nothing", async () => {
    await projection().project(runInput());
    await projection().project(runInput({ revision: 2 }));

    expect(harness.revisions).toHaveLength(0);
  });

  it("ignores a stale revision and keeps the newer value", async () => {
    await projection().project(runInput({ revision: 4 }));
    await projection().project(
      runInput({ revision: 3, facts: [webFact({ value: 9 })] }),
    );

    expect([...harness.facts.values()][0]).toMatchObject({
      value: 120,
      revision: 4,
    });
  });

  it("treats a repeated revision as an idempotent replay", async () => {
    await projection().project(runInput());
    await projection().project(
      runInput({ facts: [webFact({ value: 999 })] }),
    );

    expect([...harness.facts.values()][0]).toMatchObject({ value: 120 });
    expect(harness.revisions).toHaveLength(0);
  });
});

describe("source degradation", () => {
  it("records an outage without writing facts or advancing completeness", async () => {
    await projection().project(runInput());
    await projection().project({
      source: "cloudflare_web",
      sourceName: "cloudflare",
      definitionVersion: 1,
      outcome: "unavailable",
      errorCode: "provider_quota_exceeded",
      attemptedAt: "2026-08-02T02:00:00.000Z",
      nextRetryAt: "2026-08-02T02:30:00.000Z",
    });

    expect(harness.facts.size).toBe(1);
    expect([...harness.facts.values()][0]).toMatchObject({ value: 120 });
    expect(harness.sourceStates.get("cloudflare_web|cloudflare")).toMatchObject(
      {
        status: "unavailable",
        errorCode: "provider_quota_exceeded",
        completeThrough: "2026-08-02T00:00:00.000Z",
        lastSuccessAt: "2026-08-02T01:00:00.000Z",
        nextRetryAt: "2026-08-02T02:30:00.000Z",
      },
    );
  });

  it("keeps the earlier completeness when a run reports less coverage", async () => {
    await projection().project(runInput());
    await projection().project(
      runInput({
        revision: 2,
        completeThrough: "2026-08-01T12:00:00.000Z",
        observedAt: "2026-08-02T03:00:00.000Z",
      }),
    );

    expect(harness.sourceStates.get("cloudflare_web|cloudflare")).toMatchObject(
      {
        status: "partial",
        completeThrough: "2026-08-02T00:00:00.000Z",
      },
    );
  });

  it("leaves the read model untouched when the commit fails", async () => {
    harness.failNextCommit();

    await expect(projection().project(runInput())).rejects.toThrow(
      "d1_unavailable",
    );
    expect(harness.facts.size).toBe(0);
    expect(harness.sourceStates.size).toBe(0);
  });
});

describe("compaction", () => {
  async function projectHours() {
    await projection().project(
      runInput({
        completeThrough: "2026-05-02T00:00:00.000Z",
        facts: [
          webFact({
            granularity: "hour",
            bucketStartUtc: "2026-05-01T00:00:00.000Z",
            bucketEndUtc: "2026-05-01T01:00:00.000Z",
            value: 5,
          }),
          webFact({
            granularity: "hour",
            bucketStartUtc: "2026-05-01T01:00:00.000Z",
            bucketEndUtc: "2026-05-01T02:00:00.000Z",
            value: 7,
          }),
        ],
      }),
    );
  }

  it("replaces covered hourly facts with one daily fact", async () => {
    await projectHours();

    const outcome = await projection("2026-08-02T00:00:00.000Z").compact({
      hourlyRetentionDays: 90,
    });

    expect(outcome.dailyFactsWritten).toBe(1);
    expect(outcome.hourlyFactsRemoved).toBe(2);
    const stored = [...harness.facts.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      granularity: "day",
      bucketStartUtc: "2026-05-01T00:00:00.000Z",
      bucketEndUtc: "2026-05-02T00:00:00.000Z",
      value: 12,
    });
  });

  it("keeps hourly facts inside the retention window", async () => {
    await projectHours();

    const outcome = await projection("2026-05-10T00:00:00.000Z").compact({
      hourlyRetentionDays: 90,
    });

    expect(outcome.dailyFactsWritten).toBe(0);
    expect(harness.facts.size).toBe(2);
  });

  it("refuses to merge hours whose measurements are not comparable", async () => {
    await projectHours();
    await projection().project(
      runInput({
        sourceMetric: "pageViewsV2",
        definitionVersion: 2,
        completeThrough: "2026-05-02T00:00:00.000Z",
        facts: [
          webFact({
            granularity: "hour",
            bucketStartUtc: "2026-05-01T02:00:00.000Z",
            bucketEndUtc: "2026-05-01T03:00:00.000Z",
            value: 4,
          }),
        ],
      }),
    );

    const outcome = await projection("2026-08-02T00:00:00.000Z").compact({
      hourlyRetentionDays: 90,
    });

    expect(outcome).toMatchObject({
      dailyFactsWritten: 0,
      hourlyFactsRemoved: 0,
      daysSkippedForComparability: 1,
    });
    expect(harness.facts.size).toBe(3);
    expect(
      [...harness.facts.values()].every(
        (fact) => fact.granularity === "hour",
      ),
    ).toBe(true);
  });

  it("carries the least complete observation into the daily fact", async () => {
    await projectHours();

    await projection("2026-08-02T00:00:00.000Z").compact({
      hourlyRetentionDays: 90,
    });

    expect([...harness.facts.values()][0]).toMatchObject({
      observedAt: "2026-08-02T01:00:00.000Z",
      completeThrough: "2026-05-02T00:00:00.000Z",
    });
  });
});

describe("source status after a run", () => {
  it("stays healthy when a measurement is legitimately not measured", async () => {
    await projection().project(
      runInput({
        facts: [
          webFact({
            metricKey: "web.vitals.lcp_p75",
            subjectType: "content",
            subjectId: "content_home",
            unit: "milliseconds",
            quality: "partial_population",
            value: null,
            unavailableReason: "not_measured",
          }),
        ],
      }),
    );

    expect(
      harness.sourceStates.get("cloudflare_web|cloudflare"),
    ).toMatchObject({ status: "healthy" });
  });

  it("reports partial when the source omitted something it was asked for", async () => {
    await projection().project(
      runInput({
        source: "provider",
        sourceName: "brevo",
        sourceMetric: "uniqueClicks",
        facts: [
          webFact({
            metricKey: "campaign.unique_clicks_reported",
            subjectType: "campaign",
            subjectId: "campaign_1",
            granularity: "campaign",
            quality: "directional",
            value: null,
            unavailableReason: "provider_omitted",
          }),
        ],
      }),
    );

    expect(harness.sourceStates.get("provider|brevo")).toMatchObject({
      status: "partial",
    });
  });
});

describe("retention", () => {
  it("removes facts whose bucket closed before the retention floor", async () => {
    await projection().project(
      runInput({
        facts: [
          webFact({
            bucketStartUtc: "2024-01-01T00:00:00.000Z",
            bucketEndUtc: "2024-01-02T00:00:00.000Z",
          }),
        ],
      }),
    );
    await projection().project(
      runInput({ revision: 2, facts: [webFact({ value: 7 })] }),
    );
    expect(harness.facts.size).toBe(2);

    const outcome = await projection().purge({ aggregateFactMonths: 25 });

    expect(outcome.factsRemoved).toBe(1);
    expect([...harness.facts.values()]).toEqual([
      expect.objectContaining({ bucketStartUtc: "2026-08-01T00:00:00.000Z" }),
    ]);
  });

  it("keeps a fact that is still inside the retained window", async () => {
    await projection().project(runInput());

    const outcome = await projection().purge({ aggregateFactMonths: 25 });

    expect(outcome.factsRemoved).toBe(0);
    expect(harness.facts.size).toBe(1);
  });
});
