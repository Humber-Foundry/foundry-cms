import { beforeAll, describe, expect, it } from "vitest";

import { computeConfigurationFingerprint } from "./configuration-fingerprint";
import { createInstallationIdentity } from "./installation-identity";
import {
  ProvisioningReceiptError,
  appendProvisioningReceipt,
  createEd25519ReceiptSigner,
  createInMemoryProvisioningStateStore,
  createReceiptChainIntentLog,
  provisioningReceiptDirectory,
  provisioningReceiptPath,
  provisioningStateBranch,
  verifyEd25519Receipt,
  verifyProvisioningReceiptChain,
  type ProvisioningReceipt,
  type ReceiptSigner,
} from "./provisioning-receipts";
import { createResourceCreateIntent } from "./resource-reconciliation";

const installationId = "01984f2a-1c00-7000-8000-0000000000aa";
const deploymentId = "01984f2a-1c00-7000-8000-0000000000bb";
const operationId = "01984f2a-1c00-7000-8000-000000000001";
const accountScopeFingerprint = `sha256:${"9".repeat(64)}`;

let signer: ReceiptSigner;
let impostor: ReceiptSigner;

async function newSigner(): Promise<ReceiptSigner> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return createEd25519ReceiptSigner(pair.privateKey, pair.publicKey);
}

beforeAll(async () => {
  signer = await newSigner();
  impostor = await newSigner();
});

async function identity() {
  return createInstallationIdentity({
    installationId,
    deploymentId,
    label: "Acme Marine",
  });
}

async function chainOf(
  count: number,
  { with: withSigner = () => signer }: { with?: () => ReceiptSigner } = {},
): Promise<ProvisioningReceipt[]> {
  const receipts: ProvisioningReceipt[] = [];
  for (let index = 0; index < count; index += 1) {
    receipts.push(
      await appendProvisioningReceipt({
        chain: receipts,
        installationId,
        deploymentId,
        operationId,
        recordedAt: `2026-07-27T00:0${index}:00.000Z`,
        payload: { kind: "installation.initialized", resourceStem: "acme-x" },
        signer: withSigner(),
      }),
    );
  }
  return receipts;
}

function verifyChain(
  receipts: ReadonlyArray<ProvisioningReceipt>,
  trustAnchorPublicKey = signer.publicKey,
) {
  return verifyProvisioningReceiptChain({
    receipts,
    trustAnchorPublicKey,
    installationId,
    verify: verifyEd25519Receipt,
  });
}

describe("receipt chain", () => {
  it("lives on the documented branch and path", async () => {
    const [root] = await chainOf(1);

    expect(provisioningStateBranch).toBe("foundry/provisioning-state");
    expect(provisioningReceiptDirectory).toBe(".foundry/operations/");
    expect(provisioningReceiptPath(root as ProvisioningReceipt)).toBe(
      ".foundry/operations/000000.json",
    );
  });

  it("links each receipt to the hash of the one before it", async () => {
    const receipts = await chainOf(3);

    expect(receipts[0]?.previousReceiptHash).toBeNull();
    expect(receipts[1]?.previousReceiptHash).toBe(receipts[0]?.receiptHash);
    expect(receipts[2]?.previousReceiptHash).toBe(receipts[1]?.receiptHash);
    expect(receipts.map((receipt) => receipt.sequence)).toEqual([0, 1, 2]);
  });

  it("verifies a whole chain signed by the anchored key", async () => {
    await expect(verifyChain(await chainOf(3))).resolves.toHaveLength(3);
  });

  it("verifies an empty chain", async () => {
    await expect(verifyChain([])).resolves.toEqual([]);
  });

  it("blocks a chain whose payload was edited after signing", async () => {
    const receipts = await chainOf(2);
    const tampered = [
      receipts[0] as ProvisioningReceipt,
      {
        ...(receipts[1] as ProvisioningReceipt),
        payload: {
          kind: "installation.initialized" as const,
          resourceStem: "attacker-x",
        },
      },
    ];

    await expect(verifyChain(tampered)).rejects.toThrow(
      /receipt_hash_mismatch/u,
    );
  });

  it("blocks a chain whose hash was recomputed but not re-signed", async () => {
    const receipts = await chainOf(2);
    const forged = await appendProvisioningReceipt({
      chain: [receipts[0] as ProvisioningReceipt],
      installationId,
      deploymentId,
      operationId,
      recordedAt: "2026-07-27T00:01:00.000Z",
      payload: {
        kind: "installation.initialized",
        resourceStem: "attacker-x",
      },
      signer: impostor,
    });

    await expect(
      verifyChain([receipts[0] as ProvisioningReceipt, forged]),
    ).rejects.toThrow(/receipt_signer_unexpected/u);
  });

  it("blocks a chain signed by a key the manifest does not anchor", async () => {
    await expect(
      verifyChain(await chainOf(2, { with: () => impostor })),
    ).rejects.toThrow(/receipt_signer_unexpected/u);
  });

  it("blocks a chain whose signature does not verify", async () => {
    const receipts = await chainOf(1);
    const stripped = {
      ...(receipts[0] as ProvisioningReceipt),
      signature: "AAAA",
    };

    await expect(verifyChain([stripped])).rejects.toThrow(
      /receipt_signature_invalid/u,
    );
  });

  it("blocks a chain with a deleted receipt", async () => {
    const receipts = await chainOf(3);

    await expect(
      verifyChain([
        receipts[0] as ProvisioningReceipt,
        receipts[2] as ProvisioningReceipt,
      ]),
    ).rejects.toThrow(/receipt_sequence_broken/u);
  });

  it("blocks a chain that does not start at its root", async () => {
    const receipts = await chainOf(2);

    await expect(
      verifyChain([receipts[1] as ProvisioningReceipt]),
    ).rejects.toThrow(/receipt_sequence_broken/u);
  });

  it("blocks a receipt belonging to another installation", async () => {
    const receipts = await chainOf(1);
    await expect(
      verifyProvisioningReceiptChain({
        receipts,
        trustAnchorPublicKey: signer.publicKey,
        installationId: "01984f2a-1c00-7000-8000-0000000000dd",
        verify: verifyEd25519Receipt,
      }),
    ).rejects.toThrow(/receipt_installation_mismatch/u);
  });

  it("blocks a receipt from an incompatible schema", async () => {
    const receipts = await chainOf(1);
    await expect(
      verifyChain([
        {
          ...(receipts[0] as ProvisioningReceipt),
          schemaVersion: "foundry.provisioning-receipt/v2",
        },
      ]),
    ).rejects.toThrow(/receipt_schema_incompatible/u);
  });

  it("refuses to record credential material in a receipt", async () => {
    await expect(
      appendProvisioningReceipt({
        chain: [],
        installationId,
        deploymentId,
        operationId,
        recordedAt: "2026-07-27T00:00:00.000Z",
        payload: {
          kind: "installation.initialized",
          resourceStem: "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
        },
        signer,
      }),
    ).rejects.toThrow();
  });
});

describe("append conflicts", () => {
  it("refuses a concurrent append that would fork the branch", async () => {
    const store = createInMemoryProvisioningStateStore();
    const [root] = await chainOf(1);

    await store.append(root as ProvisioningReceipt, { expectedLength: 0 });
    await expect(
      store.append(root as ProvisioningReceipt, { expectedLength: 0 }),
    ).rejects.toThrow(ProvisioningReceiptError);
  });
});

describe("create-intent log", () => {
  async function createLog() {
    const store = createInMemoryProvisioningStateStore();
    return {
      store,
      log: createReceiptChainIntentLog({
        store,
        signer,
        verify: verifyEd25519Receipt,
        trustAnchorPublicKey: signer.publicKey,
        installationId,
        deploymentId,
        operationId,
        now: () => "2026-07-27T00:00:00.000Z",
      }),
    };
  }

  async function intent(overrides: Record<string, unknown> = {}) {
    return createResourceCreateIntent({
      identity: await identity(),
      provider: "cloudflare",
      resourceKind: "d1",
      resourceName: "acme-kmnpqrstuvwxyzab",
      operationId,
      accountScopeFingerprint,
      desiredFingerprint: await computeConfigurationFingerprint({ kind: "d1" }),
      notBefore: "2026-07-27T00:00:00.000Z",
      operationWindowSeconds: 900,
      nonce: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
      preflightProvedAbsent: true,
      ...overrides,
    });
  }

  it("commits an intent as a signed receipt and finds it again", async () => {
    const { store, log } = await createLog();
    const committed = await intent();
    await log.commit(committed);

    expect(await store.read()).toHaveLength(1);
    expect(
      await log.find({
        provider: "cloudflare",
        resourceKind: "d1",
        resourceName: "acme-kmnpqrstuvwxyzab",
      }),
    ).toEqual(committed);
  });

  it("finds no intent for a different resource", async () => {
    const { log } = await createLog();
    await log.commit(await intent());

    expect(
      await log.find({
        provider: "cloudflare",
        resourceKind: "r2",
        resourceName: "acme-kmnpqrstuvwxyzab",
      }),
    ).toBeNull();
  });

  it("refuses to read intents once the chain no longer verifies", async () => {
    const { store, log } = await createLog();
    await log.commit(await intent());
    await store.append(
      {
        ...((await store.read())[0] as ProvisioningReceipt),
        sequence: 5,
      },
      { expectedLength: 1 },
    );

    await expect(
      log.find({
        provider: "cloudflare",
        resourceKind: "d1",
        resourceName: "acme-kmnpqrstuvwxyzab",
      }),
    ).rejects.toThrow(ProvisioningReceiptError);
  });

  it("reports a later conflicting intent for the same resource", async () => {
    const { log } = await createLog();
    const first = await intent();
    await log.commit(first);

    expect(await log.hasLaterConflictingIntent(first)).toBe(false);

    await log.commit(
      await intent({ nonce: "ffffffffffffffffffffffffffffffff" }),
    );
    expect(await log.hasLaterConflictingIntent(first)).toBe(true);
  });

  it("treats an intent absent from the chain as conflicting", async () => {
    const { log } = await createLog();

    expect(await log.hasLaterConflictingIntent(await intent())).toBe(true);
  });
});
