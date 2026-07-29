import { describe, expect, it, vi } from "vitest";

import { computeConfigurationFingerprint } from "./configuration-fingerprint";
import { createInstallationIdentity } from "./installation-identity";
import {
  createProvisioningResource,
  createProvisioningStep,
  transitionStep,
} from "./provisioning-journal";
import {
  createEd25519ReceiptSigner,
  createInMemoryProvisioningStateStore,
  createReceiptChainIntentLog,
  verifyEd25519Receipt,
} from "./provisioning-receipts";
import {
  ReconciliationReviewRequiredError,
  classifyResourceObservation,
  createResourceCreateIntent,
  evaluateCreateIntentAdoption,
  reconcileResource,
} from "./resource-reconciliation";

const installationId = "01984f2a-1c00-7000-8000-0000000000aa";
const deploymentId = "01984f2a-1c00-7000-8000-0000000000bb";
const otherInstallationId = "01984f2a-1c00-7000-8000-0000000000dd";
const operationId = "01984f2a-1c00-7000-8000-000000000001";
const accountScopeFingerprint = `sha256:${"9".repeat(64)}`;
const inputHash = `sha256:${"a".repeat(64)}`;

const desiredConfiguration = {
  kind: "d1",
  name: "acme-kmnpqrstuvwxyzab",
  readReplication: "disabled",
  location: "weur",
};

async function identity() {
  return createInstallationIdentity({
    installationId,
    deploymentId,
    label: "Acme Marine",
  });
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    providerResourceId: "8f0b1c2d-3e4f-5061-7283-94a5b6c7d8e9",
    displayName: "acme-kmnpqrstuvwxyzab",
    installationMarker: installationId,
    deploymentMarker: deploymentId,
    configuration: desiredConfiguration,
    createdAt: "2026-07-27T00:05:00.000Z",
    createRequestId: null,
    ...overrides,
  };
}

async function classify(
  candidates: ReadonlyArray<Record<string, unknown>>,
  options: Record<string, unknown> = {},
) {
  return classifyResourceObservation({
    identity: await identity(),
    desiredConfiguration,
    desiredFingerprint: await computeConfigurationFingerprint(
      desiredConfiguration,
    ),
    candidates: candidates as never,
    repairableFields: ["readReplication"],
    ...options,
  });
}

describe("observation classification", () => {
  it("classifies no candidate as absent", async () => {
    expect((await classify([])).classification).toBe("absent");
  });

  it("classifies a marked candidate with the intended configuration as exact", async () => {
    const observation = await classify([candidate()]);

    expect(observation.classification).toBe("exact");
    expect(observation.candidate?.providerResourceId).toBe(
      "8f0b1c2d-3e4f-5061-7283-94a5b6c7d8e9",
    );
  });

  it("classifies a marked candidate drifting only in repairable fields as repairable_drift", async () => {
    const observation = await classify([
      candidate({
        configuration: { ...desiredConfiguration, readReplication: "enabled" },
      }),
    ]);

    expect(observation.classification).toBe("repairable_drift");
    expect(observation.drift).toEqual(["readReplication"]);
  });

  it("classifies drift in an immutable field as incompatible_drift", async () => {
    const observation = await classify([
      candidate({
        configuration: { ...desiredConfiguration, location: "apac" },
      }),
    ]);

    expect(observation.classification).toBe("incompatible_drift");
    expect(observation.drift).toEqual(["location"]);
  });

  it("classifies mixed repairable and immutable drift as incompatible_drift", async () => {
    const observation = await classify([
      candidate({
        configuration: {
          ...desiredConfiguration,
          location: "apac",
          readReplication: "enabled",
        },
      }),
    ]);

    expect(observation.classification).toBe("incompatible_drift");
    expect(observation.drift).toEqual(["location", "readReplication"]);
  });

  it("classifies a candidate marked for another installation as foreign", async () => {
    expect(
      (await classify([candidate({ installationMarker: otherInstallationId })]))
        .classification,
    ).toBe("foreign");
  });

  it("classifies a candidate marked for a superseded deployment as foreign", async () => {
    expect(
      (
        await classify([
          candidate({
            deploymentMarker: "01984f2a-1c00-7000-8000-0000000000cc",
          }),
        ])
      ).classification,
    ).toBe("foreign");
  });

  it("classifies an unmarked name collision as ambiguous", async () => {
    const observation = await classify([
      candidate({ installationMarker: null, deploymentMarker: null }),
    ]);

    expect(observation.classification).toBe("ambiguous");
  });

  it("classifies more than one candidate as ambiguous even when one is marked", async () => {
    const observation = await classify([
      candidate(),
      candidate({
        providerResourceId: "other",
        installationMarker: null,
        deploymentMarker: null,
      }),
    ]);

    expect(observation.classification).toBe("ambiguous");
    expect(observation.candidates).toHaveLength(2);
  });

  it("never treats a name match alone as proof of ownership", async () => {
    const observation = await classify([
      candidate({
        installationMarker: null,
        deploymentMarker: null,
        configuration: desiredConfiguration,
      }),
    ]);

    expect(observation.classification).not.toBe("exact");
  });
});

describe("create intents", () => {
  it("records the facts an adoption decision needs and no account id", async () => {
    const intent = await createResourceCreateIntent({
      identity: await identity(),
      provider: "cloudflare",
      resourceKind: "d1",
      resourceName: "acme-kmnpqrstuvwxyzab",
      operationId,
      accountScopeFingerprint,
      desiredFingerprint: await computeConfigurationFingerprint(
        desiredConfiguration,
      ),
      notBefore: "2026-07-27T00:00:00.000Z",
      operationWindowSeconds: 900,
      nonce: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
      preflightProvedAbsent: true,
    });

    expect(intent).toMatchObject({
      provider: "cloudflare",
      resourceName: "acme-kmnpqrstuvwxyzab",
      installationId,
      deploymentId,
      accountScopeFingerprint,
      notBefore: "2026-07-27T00:00:00.000Z",
      notAfter: "2026-07-27T00:15:00.000Z",
    });
    expect(JSON.stringify(intent)).not.toContain("accountId");
  });

  it("refuses an intent whose preflight did not prove the name absent", async () => {
    await expect(
      createResourceCreateIntent({
        identity: await identity(),
        provider: "cloudflare",
        resourceKind: "d1",
        resourceName: "acme-kmnpqrstuvwxyzab",
        operationId,
        accountScopeFingerprint,
        desiredFingerprint: await computeConfigurationFingerprint(
          desiredConfiguration,
        ),
        notBefore: "2026-07-27T00:00:00.000Z",
        operationWindowSeconds: 900,
        nonce: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
        preflightProvedAbsent: false,
      }),
    ).rejects.toThrow();
  });
});

describe("automatic adoption of an ambiguous candidate", () => {
  async function intent(overrides: Record<string, unknown> = {}) {
    return createResourceCreateIntent({
      identity: await identity(),
      provider: "cloudflare",
      resourceKind: "d1",
      resourceName: "acme-kmnpqrstuvwxyzab",
      operationId,
      accountScopeFingerprint,
      desiredFingerprint: await computeConfigurationFingerprint(
        desiredConfiguration,
      ),
      notBefore: "2026-07-27T00:00:00.000Z",
      operationWindowSeconds: 900,
      nonce: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
      preflightProvedAbsent: true,
      ...overrides,
    });
  }

  async function evaluate(overrides: Record<string, unknown> = {}) {
    return evaluateCreateIntentAdoption({
      intent: await intent(),
      candidates: [
        candidate({
          installationMarker: null,
          deploymentMarker: null,
          createRequestId: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
        }),
      ],
      intentCommitted: true,
      accountScopeFingerprint,
      laterConflictingIntentExists: false,
      ...overrides,
    });
  }

  it("adopts only when the provider conclusively binds the resource to this operation", async () => {
    const decision = await evaluate();

    expect(decision.adopted).toBe(true);
    expect(decision.candidate?.providerResourceId).toBe(
      "8f0b1c2d-3e4f-5061-7283-94a5b6c7d8e9",
    );
  });

  it("refuses adoption when the provider exposes no create-request binding", async () => {
    const decision = await evaluate({
      candidates: [
        candidate({
          installationMarker: null,
          deploymentMarker: null,
          createRequestId: null,
        }),
      ],
    });

    expect(decision.adopted).toBe(false);
    expect(decision.code).toBe("adoption.request_binding_absent");
  });

  it("refuses adoption when the create-request binding is for another operation", async () => {
    const decision = await evaluate({
      candidates: [
        candidate({
          installationMarker: null,
          deploymentMarker: null,
          createRequestId: "ffffffffffffffffffffffffffffffff",
        }),
      ],
    });

    expect(decision.adopted).toBe(false);
    expect(decision.code).toBe("adoption.request_binding_mismatch");
  });

  it("refuses adoption when the intent is not committed to the client repository", async () => {
    expect((await evaluate({ intentCommitted: false })).code).toBe(
      "adoption.intent_not_committed",
    );
  });

  it("refuses adoption when the provider reports more than one candidate", async () => {
    const decision = await evaluate({
      candidates: [
        candidate({
          installationMarker: null,
          deploymentMarker: null,
          createRequestId: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
        }),
        candidate({
          providerResourceId: "second",
          installationMarker: null,
          deploymentMarker: null,
          createRequestId: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
        }),
      ],
    });

    expect(decision.adopted).toBe(false);
    expect(decision.code).toBe("adoption.multiple_candidates");
  });

  it("refuses adoption when the account scope no longer matches", async () => {
    expect(
      (
        await evaluate({
          accountScopeFingerprint: `sha256:${"1".repeat(64)}`,
        })
      ).code,
    ).toBe("adoption.account_scope_mismatch");
  });

  it("refuses adoption when the candidate was created before the intent", async () => {
    const decision = await evaluate({
      candidates: [
        candidate({
          installationMarker: null,
          deploymentMarker: null,
          createRequestId: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
          createdAt: "2026-07-26T23:00:00.000Z",
        }),
      ],
    });

    expect(decision.code).toBe("adoption.creation_time_outside_window");
  });

  it("refuses adoption when the candidate was created after the operation window", async () => {
    const decision = await evaluate({
      candidates: [
        candidate({
          installationMarker: null,
          deploymentMarker: null,
          createRequestId: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
          createdAt: "2026-07-27T02:00:00.000Z",
        }),
      ],
    });

    expect(decision.code).toBe("adoption.creation_time_outside_window");
  });

  it("refuses adoption when the candidate configuration is neither empty nor intended", async () => {
    const decision = await evaluate({
      candidates: [
        candidate({
          installationMarker: null,
          deploymentMarker: null,
          createRequestId: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
          configuration: { ...desiredConfiguration, location: "apac" },
        }),
      ],
    });

    expect(decision.code).toBe("adoption.configuration_mismatch");
  });

  it("adopts a candidate whose configuration is still empty", async () => {
    const decision = await evaluate({
      candidates: [
        candidate({
          installationMarker: null,
          deploymentMarker: null,
          createRequestId: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
          configuration: {},
        }),
      ],
    });

    expect(decision.adopted).toBe(true);
  });

  it("refuses adoption when a later conflicting intent exists", async () => {
    expect((await evaluate({ laterConflictingIntentExists: true })).code).toBe(
      "adoption.later_conflicting_intent",
    );
  });

  it("refuses adoption when the name does not match the intent", async () => {
    const decision = await evaluate({
      candidates: [
        candidate({
          displayName: "acme-other-suffix",
          installationMarker: null,
          deploymentMarker: null,
          createRequestId: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
        }),
      ],
    });

    expect(decision.code).toBe("adoption.name_mismatch");
  });
});

describe("reconciling one resource", () => {
  function provider(overrides: Record<string, unknown> = {}) {
    return {
      findByProviderResourceId: vi.fn(async () => null),
      findByName: vi.fn(async () => [] as ReadonlyArray<unknown>),
      create: vi.fn(async () => candidate()),
      patch: vi.fn(async () => candidate()),
      readBack: vi.fn(async () => candidate()),
      healthCheck: vi.fn(async () => ({
        passed: true,
        checkIds: ["d1.transaction-canary"],
      })),
      writeInstallationMarker: vi.fn(async () => candidate()),
      ...overrides,
    };
  }

  let nonceCounter = 0;

  async function createIntentLog() {
    const bound = await identity();
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const signer = await createEd25519ReceiptSigner(
      pair.privateKey,
      pair.publicKey,
    );
    const store = createInMemoryProvisioningStateStore();
    return {
      store,
      signer,
      log: createReceiptChainIntentLog({
        store,
        signer,
        verify: verifyEd25519Receipt,
        trustAnchorPublicKey: signer.publicKey,
        installationId: bound.installationId,
        deploymentId: bound.deploymentId,
        operationId,
        now: () => "2026-07-27T00:04:00.000Z",
      }),
    };
  }

  function nextNonce() {
    nonceCounter += 1;
    return nonceCounter.toString(16).padStart(32, "0");
  }

  async function reconcile(
    providerOperations: Record<string, unknown>,
    options: Record<string, unknown> = {},
  ) {
    return reconcileResource({
      identity: await identity(),
      step: createProvisioningStep({
        stepId: "cloudflare.d1",
        inputHash,
        createdAt: "2026-07-27T00:00:00.000Z",
      }),
      target: {
        provider: "cloudflare",
        resourceKind: "d1",
        resourceName: "acme-kmnpqrstuvwxyzab",
      },
      desiredConfiguration,
      repairableFields: ["readReplication"],
      operations: providerOperations as never,
      operationId,
      accountScopeFingerprint,
      recordedProviderResourceId: null,
      createIntentProtocol: {
        log: (await createIntentLog()).log,
        generateNonce: nextNonce,
      },
      now: () => "2026-07-27T00:06:00.000Z",
      ...options,
    });
  }

  it("inspects before it writes and creates only a proved-absent resource", async () => {
    const operations = provider();
    const result = await reconcile(operations);

    expect(operations.findByName).toHaveBeenCalledOnce();
    expect(operations.create).toHaveBeenCalledOnce();
    expect(operations.readBack).toHaveBeenCalledOnce();
    expect(operations.healthCheck).toHaveBeenCalledOnce();
    expect(result.step.status).toBe("verified");
    expect(result.classification).toBe("absent");
    expect(result.resource?.adopted).toBe(false);
  });

  it("prefers the recorded provider id over the deterministic name", async () => {
    const operations = provider({
      findByProviderResourceId: vi.fn(async () => candidate()),
    });
    const result = await reconcile(operations, {
      recordedProviderResourceId: "8f0b1c2d-3e4f-5061-7283-94a5b6c7d8e9",
    });

    expect(operations.findByProviderResourceId).toHaveBeenCalledOnce();
    expect(operations.findByName).not.toHaveBeenCalled();
    expect(operations.create).not.toHaveBeenCalled();
    expect(result.classification).toBe("exact");
  });

  it("returns the existing receipt without writing when the resource is exact", async () => {
    const operations = provider({
      findByName: vi.fn(async () => [candidate()]),
    });
    const result = await reconcile(operations);

    expect(operations.create).not.toHaveBeenCalled();
    expect(operations.patch).not.toHaveBeenCalled();
    expect(operations.healthCheck).toHaveBeenCalledOnce();
    expect(result.step.status).toBe("verified");
  });

  it("applies a documented patch for repairable drift", async () => {
    const drifted = candidate({
      configuration: { ...desiredConfiguration, readReplication: "enabled" },
    });
    const operations = provider({
      findByName: vi.fn(async () => [drifted]),
    });
    const result = await reconcile(operations);

    expect(operations.patch).toHaveBeenCalledOnce();
    expect(operations.create).not.toHaveBeenCalled();
    expect(result.classification).toBe("repairable_drift");
    expect(result.step.status).toBe("verified");
  });

  it("stops for review on incompatible drift without writing", async () => {
    const operations = provider({
      findByName: vi.fn(async () => [
        candidate({
          configuration: { ...desiredConfiguration, location: "apac" },
        }),
      ]),
    });

    await expect(reconcile(operations)).rejects.toThrow(
      ReconciliationReviewRequiredError,
    );
    expect(operations.create).not.toHaveBeenCalled();
    expect(operations.patch).not.toHaveBeenCalled();
  });

  it("stops for review on a foreign resource without writing", async () => {
    const operations = provider({
      findByName: vi.fn(async () => [
        candidate({ installationMarker: otherInstallationId }),
      ]),
    });

    const error = await reconcile(operations).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ReconciliationReviewRequiredError);
    expect((error as ReconciliationReviewRequiredError).classification).toBe(
      "foreign",
    );
    expect((error as ReconciliationReviewRequiredError).step.status).toBe(
      "blocked",
    );
    expect(operations.create).not.toHaveBeenCalled();
  });

  it("stops for review on an ambiguous unmarked collision without creating a duplicate", async () => {
    const operations = provider({
      findByName: vi.fn(async () => [
        candidate({ installationMarker: null, deploymentMarker: null }),
      ]),
    });

    await expect(reconcile(operations)).rejects.toThrow(
      ReconciliationReviewRequiredError,
    );
    expect(operations.create).not.toHaveBeenCalled();
  });

  it("leaves the step applied_unverified when a create response is ambiguous", async () => {
    const operations = provider({
      create: vi.fn(async () => {
        throw new Error("network_timeout");
      }),
    });

    const error = await reconcile(operations).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ReconciliationReviewRequiredError);
    expect((error as ReconciliationReviewRequiredError).step.status).toBe(
      "applied_unverified",
    );
  });

  it("does not mark a step verified when the readback disagrees with the intent", async () => {
    const operations = provider({
      readBack: vi.fn(async () =>
        candidate({
          configuration: { ...desiredConfiguration, location: "apac" },
        }),
      ),
    });

    const error = await reconcile(operations).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ReconciliationReviewRequiredError);
    expect((error as ReconciliationReviewRequiredError).step.status).toBe(
      "applied_unverified",
    );
  });

  it("does not mark a step verified when the health check fails", async () => {
    const operations = provider({
      healthCheck: vi.fn(async () => ({ passed: false, checkIds: ["d1.transaction-canary"] })),
    });

    const error = await reconcile(operations).catch((thrown: unknown) => thrown);
    expect((error as ReconciliationReviewRequiredError).step.status).toBe(
      "applied_unverified",
    );
  });

  it("adopts a conclusively bound candidate after an ambiguous write", async () => {
    const { log } = await createIntentLog();
    const nonce = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
    await log.commit(
      await createResourceCreateIntent({
        identity: await identity(),
        provider: "cloudflare",
        resourceKind: "d1",
        resourceName: "acme-kmnpqrstuvwxyzab",
        operationId,
        accountScopeFingerprint,
        desiredFingerprint: await computeConfigurationFingerprint(
          desiredConfiguration,
        ),
        notBefore: "2026-07-27T00:00:00.000Z",
        operationWindowSeconds: 900,
        nonce,
        preflightProvedAbsent: true,
      }),
    );

    const writeInstallationMarker = vi.fn(async () => candidate());
    const operations = provider({
      findByName: vi.fn(async () => [
        candidate({
          installationMarker: null,
          deploymentMarker: null,
          createRequestId: nonce,
        }),
      ]),
      writeInstallationMarker,
    });

    const result = await reconcile(operations, {
      createIntentProtocol: { log, generateNonce: nextNonce },
    });

    expect(result.classification).toBe("adopted");
    expect(result.resource?.adopted).toBe(true);
    expect(writeInstallationMarker).toHaveBeenCalledOnce();
    expect(operations.create).not.toHaveBeenCalled();
    expect(result.step.status).toBe("verified");
  });

  it("commits a durable create intent before a create the provider cannot make idempotent", async () => {
    const { store, log } = await createIntentLog();
    await reconcile(provider(), {
      createIntentProtocol: { log, generateNonce: nextNonce },
    });

    const receipts = await store.read();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.payload).toMatchObject({
      kind: "resource.create-intent",
      intent: { resourceName: "acme-kmnpqrstuvwxyzab" },
    });
  });

  it("passes the committed intent's nonce as the idempotency key", async () => {
    const { store, log } = await createIntentLog();
    const operations = provider();
    await reconcile(operations, {
      createIntentProtocol: {
        log,
        generateNonce: nextNonce,
        supportsIdempotencyKey: true,
      },
    });

    const receipts = await store.read();
    expect(receipts).toHaveLength(1);
    const committed = (
      receipts[0]?.payload as { intent: { nonce: string } }
    ).intent;
    expect(operations.create).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: committed.nonce }),
    );
  });

  it("reuses the committed intent instead of minting a second create identity", async () => {
    const { store, log } = await createIntentLog();
    const first = provider();
    await reconcile(first, {
      createIntentProtocol: {
        log,
        generateNonce: nextNonce,
        supportsIdempotencyKey: true,
      },
    });

    // A create whose response was lost leaves the resource absent; the retry
    // must reuse the same key rather than issue a second, distinct create.
    const second = provider();
    await reconcile(second, {
      createIntentProtocol: {
        log,
        generateNonce: nextNonce,
        supportsIdempotencyKey: true,
      },
    });

    expect(await store.read()).toHaveLength(1);
    expect(
      (first.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
        ?.idempotencyKey,
    ).toBe(
      (second.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
        ?.idempotencyKey,
    );
  });

  it("refuses to create at all when no intent log is available", async () => {
    await expect(
      reconcile(provider(), { createIntentProtocol: undefined }),
    ).rejects.toThrow(/create_intent_log_required/u);
  });

  function appliedUnverifiedStep() {
    return transitionStep(
      transitionStep(
        createProvisioningStep({
          stepId: "cloudflare.d1",
          inputHash,
          createdAt: "2026-07-27T00:00:00.000Z",
        }),
        { status: "applying", at: "2026-07-27T00:01:00.000Z" },
      ),
      { status: "applied_unverified", at: "2026-07-27T00:02:00.000Z" },
    );
  }

  it("verifies an exact resource on a step resumed after an ambiguous write", async () => {
    const operations = provider({
      findByName: vi.fn(async () => [candidate()]),
    });

    const result = await reconcile(operations, {
      step: appliedUnverifiedStep(),
    });

    expect(result.classification).toBe("exact");
    expect(result.step.status).toBe("verified");
    expect(operations.create).not.toHaveBeenCalled();
    expect(operations.patch).not.toHaveBeenCalled();
    expect(operations.readBack).toHaveBeenCalledOnce();
    expect(operations.healthCheck).toHaveBeenCalledOnce();
  });

  it("records that an earlier write did not land before applying again", async () => {
    const operations = provider();

    const result = await reconcile(operations, {
      step: appliedUnverifiedStep(),
    });

    expect(result.step.status).toBe("verified");
    // applying -> applied_unverified -> failed_retryable -> applying
    expect(result.step.attempt).toBe(2);
    expect(operations.create).toHaveBeenCalledOnce();
  });

  it("marks a newly created resource before the readback that must observe it", async () => {
    // A provider create returns an unmarked resource; without the marker write
    // the readback below could never prove ownership.
    const unmarked = candidate({
      installationMarker: null,
      deploymentMarker: null,
    });
    const writeInstallationMarker = vi.fn(async () => candidate());
    const operations = provider({
      create: vi.fn(async () => unmarked),
      writeInstallationMarker,
      readBack: vi.fn(async (given: { installationMarker: string | null }) =>
        given.installationMarker === null ? unmarked : candidate(),
      ),
    });

    const result = await reconcile(operations);

    expect(operations.create).toHaveBeenCalledOnce();
    expect(writeInstallationMarker).toHaveBeenCalledOnce();
    expect(writeInstallationMarker).toHaveBeenCalledWith(unmarked);
    expect(result.step.status).toBe("verified");
  });

  it("falls back to the deterministic name when a recorded id no longer resolves", async () => {
    const operations = provider({
      findByProviderResourceId: vi.fn(async () => null),
      findByName: vi.fn(async () => [candidate()]),
    });

    const result = await reconcile(operations, {
      recordedProviderResourceId: "8f0b1c2d-3e4f-5061-7283-94a5b6c7d8e9",
    });

    expect(operations.findByProviderResourceId).toHaveBeenCalledOnce();
    expect(operations.findByName).toHaveBeenCalledOnce();
    expect(operations.create).not.toHaveBeenCalled();
    expect(result.classification).toBe("exact");
  });

  it("refuses to create a duplicate when a recorded id is gone but the name is taken", async () => {
    const operations = provider({
      findByProviderResourceId: vi.fn(async () => null),
      findByName: vi.fn(async () => [
        candidate({ installationMarker: null, deploymentMarker: null }),
      ]),
    });

    await expect(
      reconcile(operations, {
        recordedProviderResourceId: "8f0b1c2d-3e4f-5061-7283-94a5b6c7d8e9",
      }),
    ).rejects.toThrow(ReconciliationReviewRequiredError);
    expect(operations.create).not.toHaveBeenCalled();
  });

  it("returns the existing verified receipt for an exact resource without writing", async () => {
    const verifiedStep = transitionStep(
      transitionStep(
        transitionStep(
          createProvisioningStep({
            stepId: "cloudflare.d1",
            inputHash,
            createdAt: "2026-07-27T00:00:00.000Z",
          }),
          { status: "applying", at: "2026-07-27T00:01:00.000Z" },
        ),
        { status: "applied_unverified", at: "2026-07-27T00:02:00.000Z" },
      ),
      {
        status: "verified",
        at: "2026-07-27T00:03:00.000Z",
        verifiedChecks: ["d1.transaction-canary"],
      },
    );
    const operations = provider({
      findByName: vi.fn(async () => [candidate()]),
    });

    const result = await reconcile(operations, { step: verifiedStep });

    expect(result.classification).toBe("exact");
    expect(result.step).toBe(verifiedStep);
    expect(result.step.attempt).toBe(1);
    expect(operations.create).not.toHaveBeenCalled();
    expect(operations.patch).not.toHaveBeenCalled();
    expect(operations.readBack).not.toHaveBeenCalled();
    expect(operations.healthCheck).not.toHaveBeenCalled();
    // No journal row was supplied, so none is invented for it.
    expect(result.resource).toBeNull();
  });

  it("preserves creation and adoption provenance for an exact resource", async () => {
    const verifiedStep = transitionStep(
      transitionStep(
        transitionStep(
          createProvisioningStep({
            stepId: "cloudflare.d1",
            inputHash,
            createdAt: "2026-07-27T00:00:00.000Z",
          }),
          { status: "applying", at: "2026-07-27T00:01:00.000Z" },
        ),
        { status: "applied_unverified", at: "2026-07-27T00:02:00.000Z" },
      ),
      {
        status: "verified",
        at: "2026-07-27T00:03:00.000Z",
        verifiedChecks: ["d1.transaction-canary"],
      },
    );
    const recordedResource = createProvisioningResource({
      installationId,
      deploymentId,
      provider: "cloudflare",
      resourceKind: "d1",
      providerResourceId: "8f0b1c2d-3e4f-5061-7283-94a5b6c7d8e9",
      displayName: "acme-kmnpqrstuvwxyzab",
      ownershipPrincipal: "client-cloudflare-account",
      createdByOperationId: "01984f2a-1c00-7000-8000-00000000000f",
      adopted: true,
      desiredFingerprint: await computeConfigurationFingerprint(
        desiredConfiguration,
      ),
      createdAt: "2026-07-27T00:02:00.000Z",
    });

    const result = await reconcile(
      provider({ findByName: vi.fn(async () => [candidate()]) }),
      { step: verifiedStep, recordedResource },
    );

    expect(result.resource?.adopted).toBe(true);
    expect(result.resource?.createdByOperationId).toBe(
      "01984f2a-1c00-7000-8000-00000000000f",
    );
    expect(result.resource?.createdByOperationId).not.toBe(operationId);
  });
});
