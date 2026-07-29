import { describe, expect, it } from "vitest";

import {
  JournalConflictError,
  ProvisioningStepError,
  ProvisioningResourceError,
  createInMemoryProvisioningJournal,
  createProvisioningStep,
  createProvisioningResource,
  isAllowedStepTransition,
  observeResource,
  provisioningStepStatuses,
  reconcileStepsAfterRestart,
  transitionStep,
} from "./provisioning-journal";

const installationId = "01984f2a-1c00-7000-8000-0000000000aa";
const deploymentId = "01984f2a-1c00-7000-8000-0000000000bb";
const operationId = "01984f2a-1c00-7000-8000-000000000001";
const inputHash = `sha256:${"a".repeat(64)}`;
const desiredFingerprint = `sha256:${"c".repeat(64)}`;

function step(overrides: Record<string, unknown> = {}) {
  return createProvisioningStep({
    stepId: "cloudflare.d1",
    prerequisites: ["github.repository"],
    inputHash,
    createdAt: "2026-07-27T00:00:00.000Z",
    ...overrides,
  });
}

describe("step records", () => {
  it("starts not_started with no attempts and no error", () => {
    expect(step()).toEqual({
      stepId: "cloudflare.d1",
      prerequisites: ["github.repository"],
      inputHash,
      status: "not_started",
      attempt: 0,
      providerRequestId: null,
      lastStableErrorCode: null,
      verifiedChecks: [],
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:00.000Z",
    });
  });

  it("names the closed set of step statuses", () => {
    expect([...provisioningStepStatuses].sort()).toEqual([
      "applied_unverified",
      "applying",
      "blocked",
      "compensating",
      "failed_retryable",
      "failed_terminal",
      "manual_action_required",
      "not_started",
      "rolled_back",
      "verified",
    ]);
  });

  it("rejects an input hash that is not a fingerprint", () => {
    expect(() => step({ inputHash: "not-a-hash" })).toThrow(
      ProvisioningStepError,
    );
  });
});

describe("step transitions", () => {
  it.each([
    ["not_started", "applying"],
    ["not_started", "blocked"],
    ["blocked", "not_started"],
    ["applying", "applied_unverified"],
    ["applying", "failed_retryable"],
    ["applying", "failed_terminal"],
    ["applied_unverified", "verified"],
    ["applied_unverified", "failed_retryable"],
    ["applied_unverified", "manual_action_required"],
    ["applied_unverified", "compensating"],
    ["failed_retryable", "applying"],
    ["manual_action_required", "applied_unverified"],
    ["verified", "applied_unverified"],
    ["verified", "compensating"],
    ["compensating", "rolled_back"],
    ["rolled_back", "applying"],
  ] as const)("allows %s -> %s", (from, to) => {
    expect(isAllowedStepTransition(from, to)).toBe(true);
  });

  it.each([
    ["not_started", "verified"],
    ["applying", "verified"],
    ["failed_terminal", "applying"],
    ["failed_terminal", "verified"],
    ["rolled_back", "verified"],
    ["blocked", "applying"],
    ["verified", "rolled_back"],
  ] as const)("refuses %s -> %s", (from, to) => {
    expect(isAllowedStepTransition(from, to)).toBe(false);
  });

  it("never allows a step to reach verified without an unverified write first", () => {
    const applying = transitionStep(step(), {
      status: "applying",
      at: "2026-07-27T00:01:00.000Z",
    });

    expect(() =>
      transitionStep(applying, {
        status: "verified",
        at: "2026-07-27T00:02:00.000Z",
      }),
    ).toThrow(ProvisioningStepError);
  });

  it("counts an attempt each time the step starts applying", () => {
    let record = transitionStep(step(), {
      status: "applying",
      at: "2026-07-27T00:01:00.000Z",
    });
    expect(record.attempt).toBe(1);

    record = transitionStep(record, {
      status: "failed_retryable",
      at: "2026-07-27T00:02:00.000Z",
      code: "provider.timeout",
    });
    record = transitionStep(record, {
      status: "applying",
      at: "2026-07-27T00:03:00.000Z",
    });
    expect(record.attempt).toBe(2);
    expect(record.lastStableErrorCode).toBe("provider.timeout");
  });

  it("records the verification checks that passed", () => {
    const applied = transitionStep(
      transitionStep(step(), {
        status: "applying",
        at: "2026-07-27T00:01:00.000Z",
      }),
      { status: "applied_unverified", at: "2026-07-27T00:02:00.000Z" },
    );
    const verified = transitionStep(applied, {
      status: "verified",
      at: "2026-07-27T00:03:00.000Z",
      verifiedChecks: ["d1.schema-ledger", "d1.transaction-canary"],
    });

    expect(verified.verifiedChecks).toEqual([
      "d1.schema-ledger",
      "d1.transaction-canary",
    ]);
  });

  it("requires at least one verification check to reach verified", () => {
    const applied = transitionStep(
      transitionStep(step(), {
        status: "applying",
        at: "2026-07-27T00:01:00.000Z",
      }),
      { status: "applied_unverified", at: "2026-07-27T00:02:00.000Z" },
    );

    expect(() =>
      transitionStep(applied, {
        status: "verified",
        at: "2026-07-27T00:03:00.000Z",
        verifiedChecks: [],
      }),
    ).toThrow(ProvisioningStepError);
  });

  it("keeps a terminal failure terminal until a corrected plan restarts it", () => {
    const failed = transitionStep(
      transitionStep(step(), {
        status: "applying",
        at: "2026-07-27T00:01:00.000Z",
      }),
      {
        status: "failed_terminal",
        at: "2026-07-27T00:02:00.000Z",
        code: "provider.policy_denied",
      },
    );

    expect(() =>
      transitionStep(failed, {
        status: "applying",
        at: "2026-07-27T00:03:00.000Z",
      }),
    ).toThrow(ProvisioningStepError);

    const replanned = transitionStep(failed, {
      status: "not_started",
      at: "2026-07-27T00:04:00.000Z",
      correctedPlanInputHash: `sha256:${"d".repeat(64)}`,
    });
    expect(replanned.status).toBe("not_started");
    expect(replanned.inputHash).toBe(`sha256:${"d".repeat(64)}`);
  });

  it("refuses to restart a terminal failure with the same plan", () => {
    const failed = transitionStep(
      transitionStep(step(), {
        status: "applying",
        at: "2026-07-27T00:01:00.000Z",
      }),
      { status: "failed_terminal", at: "2026-07-27T00:02:00.000Z" },
    );

    expect(() =>
      transitionStep(failed, {
        status: "not_started",
        at: "2026-07-27T00:03:00.000Z",
        correctedPlanInputHash: inputHash,
      }),
    ).toThrow(ProvisioningStepError);
  });

  it("refuses a provider request id that looks like credential material", () => {
    expect(() =>
      transitionStep(step(), {
        status: "applying",
        at: "2026-07-27T00:01:00.000Z",
        providerRequestId: "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
      }),
    ).toThrow(ProvisioningStepError);
  });
});

describe("restart reconciliation", () => {
  it("treats an interrupted applying step as applied_unverified", () => {
    const applying = transitionStep(step(), {
      status: "applying",
      at: "2026-07-27T00:01:00.000Z",
    });
    const [reconciled] = reconcileStepsAfterRestart([applying], {
      at: "2026-07-27T00:05:00.000Z",
    });

    expect(reconciled?.status).toBe("applied_unverified");
    expect(reconciled?.updatedAt).toBe("2026-07-27T00:05:00.000Z");
  });

  it("leaves every other status untouched", () => {
    const records = [
      step(),
      transitionStep(
        transitionStep(step({ stepId: "cloudflare.r2" }), {
          status: "applying",
          at: "2026-07-27T00:01:00.000Z",
        }),
        { status: "failed_retryable", at: "2026-07-27T00:02:00.000Z" },
      ),
    ];

    expect(
      reconcileStepsAfterRestart(records, {
        at: "2026-07-27T00:05:00.000Z",
      }).map((record) => record.status),
    ).toEqual(["not_started", "failed_retryable"]);
  });
});

describe("resource records", () => {
  function resource(overrides: Record<string, unknown> = {}) {
    return createProvisioningResource({
      installationId,
      deploymentId,
      provider: "cloudflare",
      resourceKind: "d1",
      providerResourceId: "8f0b1c2d-3e4f-5061-7283-94a5b6c7d8e9",
      displayName: "acme-kmnpqrstuvwxyzab",
      ownershipPrincipal: "client-cloudflare-account",
      createdByOperationId: operationId,
      adopted: false,
      desiredFingerprint,
      createdAt: "2026-07-27T00:02:00.000Z",
      ...overrides,
    });
  }

  it("records both identities, provider facts and lifecycle", () => {
    expect(resource()).toEqual({
      installationId,
      deploymentId,
      provider: "cloudflare",
      resourceKind: "d1",
      providerResourceId: "8f0b1c2d-3e4f-5061-7283-94a5b6c7d8e9",
      displayName: "acme-kmnpqrstuvwxyzab",
      ownershipPrincipal: "client-cloudflare-account",
      createdByOperationId: operationId,
      adopted: false,
      desiredFingerprint,
      observedFingerprint: null,
      lastVerifiedAt: null,
      lifecycle: "active",
    });
  });

  it("refuses a resource whose installation and deployment are the same id", () => {
    expect(() => resource({ deploymentId: installationId })).toThrow(
      ProvisioningResourceError,
    );
  });

  it("refuses a display name carrying credential material", () => {
    expect(() =>
      resource({ displayName: "xkeysib-0a1b2c3d4e5f60718293a4b5c6d7e8f90" }),
    ).toThrow(ProvisioningResourceError);
  });

  it("records an observation and the time it was verified", () => {
    const observed = observeResource(resource(), {
      observedFingerprint: desiredFingerprint,
      observedAt: "2026-07-27T00:03:00.000Z",
    });

    expect(observed.observedFingerprint).toBe(desiredFingerprint);
    expect(observed.lastVerifiedAt).toBe("2026-07-27T00:03:00.000Z");
  });

  it("does not set a verification time when the observation drifts", () => {
    const observed = observeResource(resource(), {
      observedFingerprint: `sha256:${"e".repeat(64)}`,
      observedAt: "2026-07-27T00:03:00.000Z",
    });

    expect(observed.lastVerifiedAt).toBeNull();
  });

  it("moves a resource through quarantine and supersession without deleting it", () => {
    const quarantined = observeResource(resource(), {
      observedFingerprint: `sha256:${"e".repeat(64)}`,
      observedAt: "2026-07-27T00:03:00.000Z",
      lifecycle: "quarantined",
    });

    expect(quarantined.lifecycle).toBe("quarantined");
    expect(
      observeResource(quarantined, {
        observedFingerprint: `sha256:${"e".repeat(64)}`,
        observedAt: "2026-07-27T00:04:00.000Z",
        lifecycle: "superseded",
      }).lifecycle,
    ).toBe("superseded");
  });
});

describe("journal concurrency", () => {
  it("assigns monotonic revisions", async () => {
    const journal = createInMemoryProvisioningJournal();

    const first = await journal.putStep(step(), { expectedRevision: 0 });
    const second = await journal.putStep(
      transitionStep(step(), {
        status: "applying",
        at: "2026-07-27T00:01:00.000Z",
      }),
      { expectedRevision: first.revision },
    );

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
  });

  it("refuses a compare-and-swap write against a stale revision", async () => {
    const journal = createInMemoryProvisioningJournal();
    await journal.putStep(step(), { expectedRevision: 0 });

    await expect(
      journal.putStep(step(), { expectedRevision: 0 }),
    ).rejects.toThrow(JournalConflictError);
  });

  it("keeps separate revisions per step", async () => {
    const journal = createInMemoryProvisioningJournal();
    await journal.putStep(step(), { expectedRevision: 0 });

    const other = await journal.putStep(step({ stepId: "cloudflare.r2" }), {
      expectedRevision: 0,
    });
    expect(other.revision).toBe(1);
  });

  it("never lets a stale local cache overwrite newer journal state", async () => {
    const journal = createInMemoryProvisioningJournal();
    const stored = await journal.putStep(step(), { expectedRevision: 0 });
    const applying = await journal.putStep(
      transitionStep(step(), {
        status: "applying",
        at: "2026-07-27T00:01:00.000Z",
      }),
      { expectedRevision: stored.revision },
    );

    await expect(
      journal.putStep(step(), { expectedRevision: stored.revision }),
    ).rejects.toThrow(JournalConflictError);
    expect((await journal.readStep("cloudflare.d1"))?.revision).toBe(
      applying.revision,
    );
  });

  it("stores resources under their provider resource id", async () => {
    const journal = createInMemoryProvisioningJournal();
    const record = createProvisioningResource({
      installationId,
      deploymentId,
      provider: "cloudflare",
      resourceKind: "d1",
      providerResourceId: "8f0b1c2d-3e4f-5061-7283-94a5b6c7d8e9",
      displayName: "acme-kmnpqrstuvwxyzab",
      ownershipPrincipal: "client-cloudflare-account",
      createdByOperationId: operationId,
      adopted: false,
      desiredFingerprint,
      createdAt: "2026-07-27T00:02:00.000Z",
    });

    await journal.putResource(record, { expectedRevision: 0 });
    const stored = await journal.readResource(
      "cloudflare",
      "8f0b1c2d-3e4f-5061-7283-94a5b6c7d8e9",
    );

    expect(stored?.record.displayName).toBe("acme-kmnpqrstuvwxyzab");
    expect(await journal.listResources()).toHaveLength(1);
  });
});
