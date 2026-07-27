import type { SiteId } from "@foundry/site-definition";

declare const publicFormIdBrand: unique symbol;

export type PublicFormId = string & {
  readonly [publicFormIdBrand]: "form";
};
export type PublicFormSubmissionId = string & {
  readonly [publicFormIdBrand]: "submission";
};
export type PublicFormReceiptId = string & {
  readonly [publicFormIdBrand]: "receipt";
};
export type PublicFormRequestHash = string & {
  readonly [publicFormIdBrand]: "request_hash";
};
export type PublicFormClassificationId = string & {
  readonly [publicFormIdBrand]: "classification";
};
export type PublicFormAuditEventId = string & {
  readonly [publicFormIdBrand]: "audit_event";
};
export type PublicFormDeliveryId = string & {
  readonly [publicFormIdBrand]: "delivery";
};
export type PublicFormOutboxEventId = string & {
  readonly [publicFormIdBrand]: "outbox_event";
};

export const createPublicFormId = (value: string) => value as PublicFormId;
export const createPublicFormSubmissionId = (value: string) =>
  value as PublicFormSubmissionId;
export const createPublicFormReceiptId = (value: string) =>
  value as PublicFormReceiptId;
export const createPublicFormRequestHash = (value: string) =>
  value as PublicFormRequestHash;
export const createPublicFormClassificationId = (value: string) =>
  value as PublicFormClassificationId;
export const createPublicFormAuditEventId = (value: string) =>
  value as PublicFormAuditEventId;
export const createPublicFormDeliveryId = (value: string) =>
  value as PublicFormDeliveryId;
export const createPublicFormOutboxEventId = (value: string) =>
  value as PublicFormOutboxEventId;

export const publicFormMaximumBodySize = 16 * 1_024;

export type PublicFormFieldDefinition = Readonly<{
  id: string;
  required: boolean;
  maximumLength: number;
}>;

export type PublicFormDefinition = Readonly<{
  id: PublicFormId;
  schemaVersion: string;
  allowedOrigin: string;
  turnstileHostname: string;
  turnstileAction: string;
  fields: ReadonlyArray<PublicFormFieldDefinition>;
}>;

export type PublicFormSubmissionIdentity = Readonly<{
  siteId: SiteId;
  formId: PublicFormId;
  submissionId: PublicFormSubmissionId;
}>;

export type PublicFormAcceptance = Readonly<{
  identity: PublicFormSubmissionIdentity;
  schemaVersion: string;
  receiptId: PublicFormReceiptId;
  requestHash: PublicFormRequestHash;
  fields: Readonly<Record<string, string>>;
  classification: "accepted" | "suspected_spam";
  deliveryStatus: "pending" | "held";
  classificationId: PublicFormClassificationId;
  auditEventId: PublicFormAuditEventId;
  deliveryId: PublicFormDeliveryId;
  outboxEventId: PublicFormOutboxEventId;
  acceptedAt: string;
}>;

export interface PublicFormAcceptanceStore {
  findReceipt(input: {
    identity: PublicFormSubmissionIdentity;
    requestHash: PublicFormRequestHash;
  }): Promise<
    | Readonly<{ outcome: "replayed"; receiptId: PublicFormReceiptId }>
    | Readonly<{ outcome: "conflict" }>
    | null
  >;
  accept(
    acceptance: PublicFormAcceptance,
  ): Promise<
    | Readonly<{ outcome: "accepted"; receiptId: PublicFormReceiptId }>
    | Readonly<{ outcome: "replayed"; receiptId: PublicFormReceiptId }>
    | Readonly<{ outcome: "conflict" }>
  >;
}

export interface PublicFormRateLimiter {
  allow(input: { key: string; formId: string }): Promise<boolean>;
}

export interface PublicFormTurnstile {
  verify(input: {
    token: string;
    idempotencyKey: string;
  }): Promise<Readonly<{ success: boolean; hostname?: string; action?: string }>>;
}

export type AcceptPublicFormCommand = Readonly<{
  formId: string;
  schemaVersion: string;
  submissionId: string;
  fields: Readonly<Record<string, unknown>>;
  turnstileToken: string;
  origin: string;
  bodySize: number;
  abuseKey: string;
  honeypot: string;
  startedAt: string;
}>;

export type PublicFormApplication = Readonly<{
  commands: Readonly<{
    accept(
      command: AcceptPublicFormCommand,
    ): Promise<Readonly<{ receiptId: string; replayed: boolean }>>;
  }>;
}>;

export class PublicFormRejectedError extends Error {
  constructor() {
    super("public_form_rejected");
    this.name = "PublicFormRejectedError";
  }
}

export class PublicFormConflictError extends Error {
  constructor() {
    super("public_form_submission_conflict");
    this.name = "PublicFormConflictError";
  }
}

export class PublicFormUnavailableError extends Error {
  readonly code:
    | "rate_limited"
    | "request_check_unavailable"
    | "persistence_unavailable";

  constructor(code: PublicFormUnavailableError["code"]) {
    super(`public_form_${code}`);
    this.name = "PublicFormUnavailableError";
    this.code = code;
  }
}

const minimumFillTimeMs = 2_000;

function reject(): never {
  throw new PublicFormRejectedError();
}

function validateFields(
  definition: PublicFormDefinition,
  values: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> {
  const expected = new Map(
    definition.fields.map((field) => [field.id, field]),
  );
  if (Object.keys(values).some((key) => !expected.has(key))) {
    reject();
  }

  const fields: Record<string, string> = {};
  for (const field of definition.fields) {
    const value = values[field.id];
    if (value === undefined) {
      if (field.required) {
        reject();
      }
      continue;
    }
    if (
      typeof value !== "string" ||
      value.length > field.maximumLength ||
      (field.required && value.trim() === "")
    ) {
      reject();
    }
    fields[field.id] = value;
  }
  return fields;
}

function isSuspectedSpam(
  fields: Readonly<Record<string, string>>,
  startedAt: string,
  acceptedAt: Date,
): boolean {
  const started = Date.parse(startedAt);
  if (
    !Number.isFinite(started) ||
    started > acceptedAt.getTime() ||
    acceptedAt.getTime() - started < minimumFillTimeMs
  ) {
    return true;
  }
  const links = Object.values(fields)
    .join(" ")
    .match(/https?:\/\//giu);
  return (links?.length ?? 0) >= 3;
}

export function createPublicFormApplication({
  siteId,
  definitions,
  store,
  rateLimiter,
  turnstile,
  clock,
  createId,
  hash,
}: {
  siteId: SiteId;
  definitions: ReadonlyArray<PublicFormDefinition>;
  store: PublicFormAcceptanceStore;
  rateLimiter: PublicFormRateLimiter;
  turnstile: PublicFormTurnstile;
  clock: () => Date;
  createId: (
    kind: "receipt" | "classification" | "audit" | "delivery" | "outbox",
  ) => string;
  hash: (value: unknown) => Promise<string>;
}): PublicFormApplication {
  return Object.freeze({
    commands: Object.freeze({
      async accept(command: AcceptPublicFormCommand) {
        const definition = definitions.find(
          (candidate) => candidate.id === command.formId,
        );
        if (
          definition === undefined ||
          command.schemaVersion !== definition.schemaVersion ||
          command.origin !== definition.allowedOrigin ||
          !Number.isInteger(command.bodySize) ||
          command.bodySize < 1 ||
          command.bodySize > publicFormMaximumBodySize ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
            command.submissionId,
          ) ||
          typeof command.abuseKey !== "string" ||
          command.abuseKey.length < 1 ||
          command.abuseKey.length > 256 ||
          command.honeypot !== "" ||
          typeof command.turnstileToken !== "string" ||
          command.turnstileToken.length < 1 ||
          command.turnstileToken.length > 2_048
        ) {
          reject();
        }
        const identity: PublicFormSubmissionIdentity = {
          siteId,
          formId: definition.id,
          submissionId: createPublicFormSubmissionId(command.submissionId),
        };
        const fields = validateFields(definition, command.fields);
        const requestHash = createPublicFormRequestHash(
          await hash({
            formId: definition.id,
            schemaVersion: command.schemaVersion,
            fields,
          }),
        );
        let withinRateCapacity: boolean;
        try {
          withinRateCapacity = await rateLimiter.allow({
            key: command.abuseKey,
            formId: definition.id,
          });
        } catch {
          throw new PublicFormUnavailableError("request_check_unavailable");
        }
        if (!withinRateCapacity) {
          throw new PublicFormUnavailableError("rate_limited");
        }
        let existing: Awaited<ReturnType<typeof store.findReceipt>>;
        try {
          existing = await store.findReceipt({
            identity,
            requestHash,
          });
        } catch {
          throw new PublicFormUnavailableError("persistence_unavailable");
        }
        if (existing?.outcome === "conflict") {
          throw new PublicFormConflictError();
        }
        if (existing?.outcome === "replayed") {
          return { receiptId: existing.receiptId, replayed: true };
        }
        let turnstileResult: Awaited<ReturnType<PublicFormTurnstile["verify"]>>;
        try {
          turnstileResult = await turnstile.verify({
            token: command.turnstileToken,
            idempotencyKey: command.submissionId,
          });
        } catch {
          throw new PublicFormUnavailableError("request_check_unavailable");
        }
        if (
          !turnstileResult.success
        ) {
          throw new PublicFormUnavailableError("request_check_unavailable");
        }
        if (
          turnstileResult.hostname !== definition.turnstileHostname ||
          turnstileResult.action !== definition.turnstileAction
        ) {
          reject();
        }
        const acceptedAt = clock();
        const suspectedSpam = isSuspectedSpam(
          fields,
          command.startedAt,
          acceptedAt,
        );
        let result: Awaited<ReturnType<PublicFormAcceptanceStore["accept"]>>;
        try {
          result = await store.accept({
            identity,
            schemaVersion: command.schemaVersion,
            receiptId: createPublicFormReceiptId(createId("receipt")),
            requestHash,
            fields,
            classification: suspectedSpam ? "suspected_spam" : "accepted",
            deliveryStatus: suspectedSpam ? "held" : "pending",
            classificationId: createPublicFormClassificationId(
              createId("classification"),
            ),
            auditEventId: createPublicFormAuditEventId(createId("audit")),
            deliveryId: createPublicFormDeliveryId(createId("delivery")),
            outboxEventId: createPublicFormOutboxEventId(createId("outbox")),
            acceptedAt: acceptedAt.toISOString(),
          });
        } catch {
          throw new PublicFormUnavailableError("persistence_unavailable");
        }
        if (result.outcome === "conflict") {
          throw new PublicFormConflictError();
        }
        return {
          receiptId: result.receiptId,
          replayed: result.outcome === "replayed",
        };
      },
    }),
  });
}
