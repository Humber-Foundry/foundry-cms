/**
 * The provisioning-state receipt chain.
 *
 * Before D1 exists — and before every provider create that has no idempotency
 * contract — the durable journal is an append-only chain of receipts committed
 * to `foundry/provisioning-state` in the client repository. Each receipt names
 * the hash of the one before it and is signed by a client-held provisioning
 * receipt key whose public half is anchored in the bootstrap manifest.
 *
 * Ordinary repository write access is therefore not enough to forge journal
 * authority: a resumed operation traverses the chain from its root and refuses
 * an unsigned receipt, a broken link, a deleted entry or an unexpected signer.
 */

import { canonicalJson, sha256CanonicalJson } from "@foundry/application";

import {
  assertNonSecretConfiguration,
  fingerprintPattern,
  type ConfigurationFingerprint,
} from "./configuration-fingerprint";
import { OperatorError } from "./operator-errors";
import type { ResourceCreateIntent } from "./resource-reconciliation";

export const provisioningReceiptSchemaVersion =
  "foundry.provisioning-receipt/v1";

export const provisioningStateBranch = "foundry/provisioning-state";

export const provisioningReceiptDirectory = ".foundry/operations/";

export type ProvisioningReceiptPayload =
  | Readonly<{ kind: "installation.initialized"; resourceStem: string }>
  | Readonly<{ kind: "resource.create-intent"; intent: ResourceCreateIntent }>
  | Readonly<{
      kind: "resource.verified";
      provider: string;
      resourceKind: string;
      providerResourceId: string;
      observedFingerprint: ConfigurationFingerprint;
    }>
  | Readonly<{
      kind: "resource.adopted";
      provider: string;
      resourceKind: string;
      providerResourceId: string;
      adoptionCode: string;
    }>;

export type ProvisioningReceiptBody = Readonly<{
  schemaVersion: string;
  sequence: number;
  previousReceiptHash: string | null;
  installationId: string;
  deploymentId: string;
  operationId: string;
  recordedAt: string;
  payload: ProvisioningReceiptPayload;
}>;

export type ProvisioningReceipt = ProvisioningReceiptBody &
  Readonly<{
    receiptHash: string;
    signature: string;
    signerPublicKey: string;
  }>;

export class ProvisioningReceiptError extends OperatorError {}

export type ReceiptSigner = Readonly<{
  /** Base64 SPKI of the public half; the private half never leaves the signer. */
  publicKey: string;
  sign(body: Uint8Array<ArrayBuffer>): Promise<Uint8Array>;
}>;

export type ReceiptVerifier = (input: {
  publicKey: string;
  signature: Uint8Array<ArrayBuffer>;
  body: Uint8Array<ArrayBuffer>;
}) => Promise<boolean>;

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bodyBytes(body: ProvisioningReceiptBody): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(canonicalJson(body));
  const bytes = new Uint8Array(new ArrayBuffer(encoded.length));
  bytes.set(encoded);
  return bytes;
}

/**
 * The file one receipt occupies on the provisioning-state branch. Sequence
 * ordering is in the name so a missing entry is visible as a gap in the tree,
 * not only in the chain.
 */
export function provisioningReceiptPath(receipt: ProvisioningReceiptBody): string {
  return `${provisioningReceiptDirectory}${String(receipt.sequence).padStart(
    6,
    "0",
  )}.json`;
}

export async function appendProvisioningReceipt({
  chain,
  installationId,
  deploymentId,
  operationId,
  recordedAt,
  payload,
  signer,
}: {
  chain: ReadonlyArray<ProvisioningReceipt>;
  installationId: string;
  deploymentId: string;
  operationId: string;
  recordedAt: string;
  payload: ProvisioningReceiptPayload;
  signer: ReceiptSigner;
}): Promise<ProvisioningReceipt> {
  assertNonSecretConfiguration(payload);

  const previous = chain[chain.length - 1] ?? null;
  const body: ProvisioningReceiptBody = {
    schemaVersion: provisioningReceiptSchemaVersion,
    sequence: previous === null ? 0 : previous.sequence + 1,
    previousReceiptHash: previous === null ? null : previous.receiptHash,
    installationId,
    deploymentId,
    operationId,
    recordedAt,
    payload,
  };

  const bytes = bodyBytes(body);
  const signature = await signer.sign(bytes);

  return Object.freeze({
    ...body,
    receiptHash: `sha256:${await sha256CanonicalJson(body)}`,
    signature: encodeBase64(signature),
    signerPublicKey: signer.publicKey,
  });
}

/**
 * Traverses the chain from its root. Any break — a wrong root, a sequence gap
 * left by a deleted entry, a hash that does not match the body, a signature
 * that does not verify, or a signer other than the anchored trust key — blocks
 * the whole chain rather than the single receipt, because a chain that can be
 * edited in one place is not evidence anywhere.
 */
export async function verifyProvisioningReceiptChain({
  receipts,
  trustAnchorPublicKey,
  installationId,
  verify,
}: {
  receipts: ReadonlyArray<ProvisioningReceipt>;
  trustAnchorPublicKey: string;
  installationId: string;
  verify: ReceiptVerifier;
}): Promise<ReadonlyArray<ProvisioningReceipt>> {
  let previous: ProvisioningReceipt | null = null;

  for (const [index, receipt] of receipts.entries()) {
    if (receipt.schemaVersion !== provisioningReceiptSchemaVersion) {
      throw new ProvisioningReceiptError("receipt_schema_incompatible");
    }
    if (receipt.sequence !== index) {
      throw new ProvisioningReceiptError("receipt_sequence_broken");
    }
    if (
      receipt.previousReceiptHash !== (previous === null ? null : previous.receiptHash)
    ) {
      throw new ProvisioningReceiptError("receipt_chain_link_broken");
    }
    if (receipt.installationId !== installationId) {
      throw new ProvisioningReceiptError("receipt_installation_mismatch");
    }
    if (receipt.signerPublicKey !== trustAnchorPublicKey) {
      throw new ProvisioningReceiptError("receipt_signer_unexpected");
    }

    const body: ProvisioningReceiptBody = {
      schemaVersion: receipt.schemaVersion,
      sequence: receipt.sequence,
      previousReceiptHash: receipt.previousReceiptHash,
      installationId: receipt.installationId,
      deploymentId: receipt.deploymentId,
      operationId: receipt.operationId,
      recordedAt: receipt.recordedAt,
      payload: receipt.payload,
    };
    if (`sha256:${await sha256CanonicalJson(body)}` !== receipt.receiptHash) {
      throw new ProvisioningReceiptError("receipt_hash_mismatch");
    }
    if (!fingerprintPattern.test(receipt.receiptHash)) {
      throw new ProvisioningReceiptError("receipt_hash_invalid");
    }

    let signatureValid = false;
    try {
      signatureValid = await verify({
        publicKey: trustAnchorPublicKey,
        signature: decodeBase64(receipt.signature),
        body: bodyBytes(body),
      });
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) {
      throw new ProvisioningReceiptError("receipt_signature_invalid");
    }

    previous = receipt;
  }

  return Object.freeze([...receipts]);
}

/**
 * Ed25519 through WebCrypto. The private key exists only for the life of the
 * signer object; only its public half is ever recorded.
 */
export async function createEd25519ReceiptSigner(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
): Promise<ReceiptSigner> {
  const spki = await crypto.subtle.exportKey("spki", publicKey);
  return Object.freeze({
    publicKey: encodeBase64(new Uint8Array(spki)),
    async sign(body: Uint8Array<ArrayBuffer>) {
      return new Uint8Array(
        await crypto.subtle.sign({ name: "Ed25519" }, privateKey, body),
      );
    },
  });
}

export const verifyEd25519Receipt: ReceiptVerifier = async ({
  publicKey,
  signature,
  body,
}) => {
  const imported = await crypto.subtle.importKey(
    "spki",
    decodeBase64(publicKey),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify({ name: "Ed25519" }, imported, signature, body);
};

export type ProvisioningStateStore = Readonly<{
  read(): Promise<ReadonlyArray<ProvisioningReceipt>>;
  /**
   * Appends one receipt with a compare-and-swap against the expected chain
   * length, so two operators cannot fork the branch.
   */
  append(
    receipt: ProvisioningReceipt,
    options: { expectedLength: number },
  ): Promise<void>;
}>;

export function createInMemoryProvisioningStateStore(): ProvisioningStateStore {
  const receipts: ProvisioningReceipt[] = [];
  return Object.freeze({
    async read() {
      return Object.freeze([...receipts]);
    },
    async append(receipt, { expectedLength }) {
      if (receipts.length !== expectedLength) {
        throw new ProvisioningReceiptError("receipt_append_conflict");
      }
      receipts.push(receipt);
    },
  });
}

export type ResourceCreateIntentLog = Readonly<{
  /** Commits the intent to the client repository before the provider create. */
  commit(intent: ResourceCreateIntent): Promise<void>;
  /** The committed intent for this resource, or null when none exists. */
  find(target: {
    provider: string;
    resourceKind: string;
    resourceName: string;
  }): Promise<ResourceCreateIntent | null>;
  /** Whether a later intent conflicts with the one being adopted. */
  hasLaterConflictingIntent(intent: ResourceCreateIntent): Promise<boolean>;
}>;

function isCreateIntentReceipt(
  receipt: ProvisioningReceipt,
): receipt is ProvisioningReceipt & {
  payload: { kind: "resource.create-intent"; intent: ResourceCreateIntent };
} {
  return receipt.payload.kind === "resource.create-intent";
}

/**
 * The create-intent log backed by the signed receipt chain. Reading always
 * re-verifies the chain, so an intent is only ever trusted as evidence when the
 * whole branch still verifies against the anchored key.
 */
export function createReceiptChainIntentLog({
  store,
  signer,
  verify,
  trustAnchorPublicKey,
  installationId,
  deploymentId,
  operationId,
  now,
}: {
  store: ProvisioningStateStore;
  signer: ReceiptSigner;
  verify: ReceiptVerifier;
  trustAnchorPublicKey: string;
  installationId: string;
  deploymentId: string;
  operationId: string;
  now: () => string;
}): ResourceCreateIntentLog {
  async function verifiedChain(): Promise<ReadonlyArray<ProvisioningReceipt>> {
    return verifyProvisioningReceiptChain({
      receipts: await store.read(),
      trustAnchorPublicKey,
      installationId,
      verify,
    });
  }

  async function committedIntents(): Promise<ReadonlyArray<ResourceCreateIntent>> {
    return (await verifiedChain())
      .filter(isCreateIntentReceipt)
      .map((receipt) => receipt.payload.intent)
      .filter((intent) => intent.deploymentId === deploymentId);
  }

  return Object.freeze({
    async commit(intent: ResourceCreateIntent) {
      const chain = await verifiedChain();
      const receipt = await appendProvisioningReceipt({
        chain,
        installationId,
        deploymentId,
        operationId,
        recordedAt: now(),
        payload: { kind: "resource.create-intent", intent },
        signer,
      });
      await store.append(receipt, { expectedLength: chain.length });
    },
    async find(target) {
      const matching = (await committedIntents()).filter(
        (intent) =>
          intent.provider === target.provider &&
          intent.resourceKind === target.resourceKind &&
          intent.resourceName === target.resourceName,
      );
      return matching[matching.length - 1] ?? null;
    },
    async hasLaterConflictingIntent(intent) {
      const intents = await committedIntents();
      const index = intents.findIndex((entry) => entry.nonce === intent.nonce);
      if (index === -1) {
        return true;
      }
      return intents
        .slice(index + 1)
        .some(
          (later) =>
            later.provider === intent.provider &&
            later.resourceKind === intent.resourceKind &&
            later.resourceName === intent.resourceName,
        );
    },
  });
}
