import "server-only";

import type { ExternalHumanIdentity } from "@humber-foundry/application";

import {
  HumanAccessConfigurationError,
  readHumanMutationConfiguration,
} from "./human-access-configuration";
import type { D1DatabaseBinding } from "./d1-human-access-store";
import { loadHumanAccessEnvironment } from "./human-access-environment";
import {
  createHumanCsrfToken,
  HumanRequestIntegrityError,
  humanTokenLifetimeSeconds,
  verifyHumanCsrfToken,
  verifyHumanMutationRequest,
} from "./human-request-integrity";

type MutationReceipt = Readonly<{
  actorIssuer: string;
  actorSubject: string;
  requestHash: string;
  status: "processing" | "completed";
  responseStatus: number | null;
  responseBody: string | null;
}>;

const localMutationReceipts = new Map<string, MutationReceipt>();

export class HumanMutationIdempotencyError extends Error {
  readonly code: "invalid_key" | "key_conflict" | "in_progress";

  constructor(code: HumanMutationIdempotencyError["code"]) {
    super(`human_mutation_${code}`);
    this.name = "HumanMutationIdempotencyError";
    this.code = code;
  }
}

export class HumanMutationExecutionNotStartedError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super("human_mutation_execution_not_started");
    this.name = "HumanMutationExecutionNotStartedError";
    this.cause = cause;
  }
}

export class HumanMutationExecutionResumableError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super("human_mutation_execution_resumable");
    this.name = "HumanMutationExecutionResumableError";
    this.cause = cause;
  }
}

function releasableExecutionCause(error: unknown) {
  return error instanceof HumanMutationExecutionNotStartedError ||
    error instanceof HumanMutationExecutionResumableError
    ? error.cause
    : undefined;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, entry]) =>
          `${JSON.stringify(key)}:${canonicalJson(entry)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function hashMutation(command: unknown) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(command)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function replayResponse(receipt: MutationReceipt) {
  if (
    receipt.status !== "completed" ||
    receipt.responseStatus === null ||
    receipt.responseBody === null
  ) {
    throw new HumanMutationIdempotencyError("in_progress");
  }
  return new Response(receipt.responseBody, {
    status: receipt.responseStatus,
    headers: { "content-type": "application/json" },
  });
}

function validateExistingReceipt({
  receipt,
  identity,
  requestHash,
}: {
  receipt: MutationReceipt;
  identity: ExternalHumanIdentity;
  requestHash: string;
}) {
  if (
    receipt.actorIssuer !== identity.binding.issuer ||
    receipt.actorSubject !== identity.binding.subject ||
    receipt.requestHash !== requestHash
  ) {
    throw new HumanMutationIdempotencyError("key_conflict");
  }
  return replayResponse(receipt);
}

async function executeWithLocalReceipt({
  idempotencyKey,
  identity,
  requestHash,
  execute,
}: {
  idempotencyKey: string;
  identity: ExternalHumanIdentity;
  requestHash: string;
  execute: () => Promise<Response>;
}) {
  const existing = localMutationReceipts.get(idempotencyKey);
  if (existing !== undefined) {
    return validateExistingReceipt({ receipt: existing, identity, requestHash });
  }
  localMutationReceipts.set(idempotencyKey, {
    actorIssuer: identity.binding.issuer,
    actorSubject: identity.binding.subject,
    requestHash,
    status: "processing",
    responseStatus: null,
    responseBody: null,
  });
  let response: Response;
  try {
    response = await execute();
  } catch (error) {
    const cause = releasableExecutionCause(error);
    if (cause !== undefined) {
      localMutationReceipts.delete(idempotencyKey);
      throw cause;
    }
    throw error;
  }
  const responseBody = await response.text();
  localMutationReceipts.set(idempotencyKey, {
    actorIssuer: identity.binding.issuer,
    actorSubject: identity.binding.subject,
    requestHash,
    status: "completed",
    responseStatus: response.status,
    responseBody,
  });
  return new Response(responseBody, {
    status: response.status,
    headers: response.headers,
  });
}

async function executeWithD1Receipt({
  database,
  idempotencyKey,
  identity,
  requestHash,
  execute,
}: {
  database: D1DatabaseBinding;
  idempotencyKey: string;
  identity: ExternalHumanIdentity;
  requestHash: string;
  execute: () => Promise<Response>;
}) {
  const now = new Date().toISOString();
  const claimed = await database
    .prepare(
      `INSERT INTO human_mutation_receipts (
         idempotency_key, actor_issuer, actor_subject, request_hash,
         status, created_at
       ) VALUES (?1, ?2, ?3, ?4, 'processing', ?5)
       ON CONFLICT (idempotency_key) DO NOTHING`,
    )
    .bind(
      idempotencyKey,
      identity.binding.issuer,
      identity.binding.subject,
      requestHash,
      now,
    )
    .run();
  if ((claimed.meta.changes ?? 0) < 1) {
    const row = await database
      .prepare(
        `SELECT
           actor_issuer, actor_subject, request_hash, status,
           response_status, response_body
         FROM human_mutation_receipts
         WHERE idempotency_key = ?1`,
      )
      .bind(idempotencyKey)
      .first<{
        actor_issuer: string;
        actor_subject: string;
        request_hash: string;
        status: "processing" | "completed";
        response_status: number | null;
        response_body: string | null;
      }>();
    if (row === null) {
      throw new HumanMutationIdempotencyError("in_progress");
    }
    return validateExistingReceipt({
      receipt: {
        actorIssuer: row.actor_issuer,
        actorSubject: row.actor_subject,
        requestHash: row.request_hash,
        status: row.status,
        responseStatus: row.response_status,
        responseBody: row.response_body,
      },
      identity,
      requestHash,
    });
  }

  let response: Response;
  try {
    response = await execute();
  } catch (error) {
    const cause = releasableExecutionCause(error);
    if (cause !== undefined) {
      await database
        .prepare(
          `DELETE FROM human_mutation_receipts
           WHERE idempotency_key = ?1
             AND actor_issuer = ?2
             AND actor_subject = ?3
             AND request_hash = ?4
             AND status = 'processing'`,
        )
        .bind(
          idempotencyKey,
          identity.binding.issuer,
          identity.binding.subject,
          requestHash,
        )
        .run();
      throw cause;
    }
    throw error;
  }
  const responseBody = await response.text();
  const completed = await database
    .prepare(
      `UPDATE human_mutation_receipts
       SET
         status = 'completed',
         response_status = ?1,
         response_body = ?2,
         completed_at = ?3
       WHERE idempotency_key = ?4
         AND actor_issuer = ?5
         AND actor_subject = ?6
         AND request_hash = ?7
         AND status = 'processing'`,
    )
    .bind(
      response.status,
      responseBody,
      new Date().toISOString(),
      idempotencyKey,
      identity.binding.issuer,
      identity.binding.subject,
      requestHash,
    )
    .run();
  if ((completed.meta.changes ?? 0) < 1) {
    throw new HumanMutationIdempotencyError("in_progress");
  }
  return new Response(responseBody, {
    status: response.status,
    headers: response.headers,
  });
}

export async function createHumanMutationToken(
  identity: ExternalHumanIdentity,
) {
  const configuration = await loadHumanMutationConfiguration();
  return createHumanCsrfToken({
    identity,
    audience: configuration.audience,
    secret: configuration.secret,
  });
}

export async function verifyHumanMutation(
  request: Request,
  identity: ExternalHumanIdentity,
) {
  const configuration = await loadHumanMutationConfiguration();
  await verifyHumanMutationRequest({
    request,
    identity,
    audience: configuration.audience,
    canonicalOrigin: configuration.canonicalOrigin,
    secret: configuration.secret,
  });
}

const mediaAccessAudienceSuffix = ":media-access";

export async function createHumanMediaAccessToken(
  identity: ExternalHumanIdentity,
  assetIds: ReadonlyArray<string>,
  issuedAt: string,
) {
  const configuration = await loadHumanMutationConfiguration();
  const now = new Date(issuedAt);
  if (!Number.isFinite(now.getTime())) {
    throw new HumanRequestIntegrityError();
  }
  return {
    token: await createHumanCsrfToken({
      identity,
      audience: `${configuration.audience}${mediaAccessAudienceSuffix}`,
      secret: configuration.secret,
      now,
      scope: assetIds,
    }),
    expiresAt:
      Math.floor(now.getTime() / 1_000) + humanTokenLifetimeSeconds,
  };
}

export async function verifyHumanMediaAccessToken(
  token: string | null,
  identity: ExternalHumanIdentity,
  assetId: string,
) {
  const configuration = await loadHumanMutationConfiguration();
  await verifyHumanCsrfToken({
    token,
    identity,
    audience: `${configuration.audience}${mediaAccessAudienceSuffix}`,
    secret: configuration.secret,
    requiredScope: assetId,
  });
}

const mediaLibraryAudienceSuffix = ":media-library";

/**
 * A capability to read thumbnails of this site's media library.
 *
 * It names no asset. A media-access capability lists the exact assets it
 * covers, and that list is carried in the token itself, so it is deliberately
 * limited to the photos placed on the page — a token naming a whole library
 * would not fit in an image URL. The gallery shows every photo, so it needs a
 * capability whose size does not grow with the library.
 *
 * This is why it is safe to leave the assets unnamed: it only ever unlocks a
 * thumbnail, which is a copy no larger than `mediaThumbnailMaxEdge`; the
 * request that presents it is already authenticated and authorized as an
 * active member of this site; and the media application it reads through is
 * scoped to that one site. An asset with no stored thumbnail answers 404 —
 * the thumbnail path never falls back to the source, or this capability
 * would become a way to read full-resolution originals. The source keeps the
 * strict per-asset capability.
 */
export async function createHumanMediaLibraryToken(
  identity: ExternalHumanIdentity,
  issuedAt: string,
) {
  const configuration = await loadHumanMutationConfiguration();
  const now = new Date(issuedAt);
  if (!Number.isFinite(now.getTime())) {
    throw new HumanRequestIntegrityError();
  }
  return {
    token: await createHumanCsrfToken({
      identity,
      audience: `${configuration.audience}${mediaLibraryAudienceSuffix}`,
      secret: configuration.secret,
      now,
    }),
    expiresAt:
      Math.floor(now.getTime() / 1_000) + humanTokenLifetimeSeconds,
  };
}

export async function verifyHumanMediaLibraryToken(
  token: string | null,
  identity: ExternalHumanIdentity,
) {
  const configuration = await loadHumanMutationConfiguration();
  await verifyHumanCsrfToken({
    token,
    identity,
    audience: `${configuration.audience}${mediaLibraryAudienceSuffix}`,
    secret: configuration.secret,
  });
}

export async function executeIdempotentHumanMutation({
  request,
  identity,
  command,
  execute,
  database,
}: {
  request: Request;
  identity: ExternalHumanIdentity;
  command: unknown;
  execute: () => Promise<Response>;
  database?: D1DatabaseBinding;
}) {
  const idempotencyKey = request.headers.get("idempotency-key");
  if (
    idempotencyKey === null ||
    !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)
  ) {
    throw new HumanMutationIdempotencyError("invalid_key");
  }
  const requestHash = await hashMutation(command);
  const environment =
    database === undefined ? await loadHumanAccessEnvironment() : null;
  const receiptDatabase = database ?? environment?.FOUNDRY_DB;
  if (receiptDatabase === undefined) {
    if (process.env.NODE_ENV !== "development" && database === undefined) {
      throw new HumanAccessConfigurationError();
    }
    return executeWithLocalReceipt({
      idempotencyKey,
      identity,
      requestHash,
      execute,
    });
  }
  return executeWithD1Receipt({
    database: receiptDatabase,
    idempotencyKey,
    identity,
    requestHash,
    execute,
  });
}

async function loadHumanMutationConfiguration() {
  return readHumanMutationConfiguration(await loadHumanAccessEnvironment());
}
