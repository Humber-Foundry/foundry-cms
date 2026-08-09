import {
  PublicFormConflictError,
  publicFormMaximumBodySize,
  PublicFormRejectedError,
  PublicFormUnavailableError,
} from "@humber-foundry/application";

import { acceptPublicFormSubmission } from "../../../../../src/public-form-runtime";

const envelopeKeys = [
  "schemaVersion",
  "submissionId",
  "fields",
  "turnstileToken",
  "honeypot",
  "startedAt",
] as const;

type PublicFormEnvelope = Readonly<{
  schemaVersion: string;
  submissionId: string;
  fields: Readonly<Record<string, unknown>>;
  turnstileToken: string;
  honeypot: string;
  startedAt: string;
}>;

function isPublicFormEnvelope(value: unknown): value is PublicFormEnvelope {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== envelopeKeys.length ||
    envelopeKeys.some((key) => !(key in value))
  ) {
    return false;
  }
  const envelope = value as Record<string, unknown>;
  return (
    typeof envelope.schemaVersion === "string" &&
    typeof envelope.submissionId === "string" &&
    typeof envelope.fields === "object" &&
    envelope.fields !== null &&
    !Array.isArray(envelope.fields) &&
    typeof envelope.turnstileToken === "string" &&
    typeof envelope.honeypot === "string" &&
    typeof envelope.startedAt === "string"
  );
}

async function readBoundedJson(
  request: Request,
): Promise<{ value: unknown; bodySize: number }> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    throw new PublicFormRejectedError();
  }
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) ||
      Number(declaredLength) > publicFormMaximumBodySize)
  ) {
    throw new PublicFormRejectedError();
  }
  if (request.body === null) {
    throw new PublicFormRejectedError();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bodySize = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    bodySize += chunk.value.byteLength;
    if (bodySize > publicFormMaximumBodySize) {
      await reader.cancel();
      throw new PublicFormRejectedError();
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(bodySize);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      bodySize,
    };
  } catch {
    throw new PublicFormRejectedError();
  }
}

function publicError(
  error: string,
  status: number,
  retryable: boolean,
): Response {
  const headers = { "cache-control": "no-store" };
  return Response.json(
    retryable ? { error, retryable: true } : { error },
    { status, headers },
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ formId: string }> },
) {
  try {
    const { value, bodySize } = await readBoundedJson(request);
    if (!isPublicFormEnvelope(value)) {
      throw new PublicFormRejectedError();
    }
    const { formId } = await context.params;
    const result = await acceptPublicFormSubmission({
      formId,
      ...value,
      origin: request.headers.get("origin") ?? "",
      bodySize,
      abuseKey: `${formId}:${request.headers.get("cf-connecting-ip") ?? "unknown"}`,
    });
    return Response.json(
      { receiptId: result.receiptId },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof PublicFormRejectedError) {
      return publicError("submission_rejected", 400, false);
    }
    if (error instanceof PublicFormConflictError) {
      return publicError("submission_identity_conflict", 409, false);
    }
    if (error instanceof PublicFormUnavailableError) {
      return publicError(
        "temporarily_unavailable",
        error.code === "rate_limited" ? 429 : 503,
        true,
      );
    }
    return publicError("temporarily_unavailable", 503, true);
  }
}
