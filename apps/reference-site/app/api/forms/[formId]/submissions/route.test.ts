import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PublicFormConflictError,
  PublicFormRejectedError,
  PublicFormUnavailableError,
} from "@humber-foundry/application";

const runtimeMocks = vi.hoisted(() => ({
  accept: vi.fn(),
}));
vi.mock("../../../../../src/public-form-runtime", () => ({
  acceptPublicFormSubmission: runtimeMocks.accept,
}));

import { POST } from "./route";

const body = {
  schemaVersion: "1.0.0",
  submissionId: "00000000-0000-4000-8000-000000000046",
  fields: { name: "Ada", message: "Please tell me more." },
  turnstileToken: "browser-token",
  honeypot: "",
  startedAt: "2026-07-27T19:59:45.000Z",
};

function request(value: unknown = body, headers: HeadersInit = {}) {
  return new Request(
    "https://foundry.example/api/forms/contact/submissions",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://foundry.example",
        "cf-connecting-ip": "192.0.2.10",
        ...headers,
      },
      body: JSON.stringify(value),
    },
  );
}

const context = { params: Promise.resolve({ formId: "contact" }) };

describe("public form endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMocks.accept.mockResolvedValue({
      receiptId: "receipt_01J00000000000000000000000",
      replayed: false,
    });
  });

  it("returns one stable durable receipt for accepted and replayed submissions", async () => {
    const first = await POST(request(), context);
    runtimeMocks.accept.mockResolvedValueOnce({
      receiptId: "receipt_01J00000000000000000000000",
      replayed: true,
    });
    const replay = await POST(request(), context);

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    await expect(first.json()).resolves.toEqual({
      receiptId: "receipt_01J00000000000000000000000",
    });
    await expect(replay.json()).resolves.toEqual({
      receiptId: "receipt_01J00000000000000000000000",
    });
    expect(runtimeMocks.accept).toHaveBeenCalledWith(
      expect.objectContaining({
        formId: "contact",
        schemaVersion: "1.0.0",
        submissionId: body.submissionId,
        fields: body.fields,
        origin: "https://foundry.example",
        abuseKey: "contact:192.0.2.10",
      }),
    );
  });

  it.each([
    ["wrong content type", request(body, { "content-type": "text/plain" })],
    [
      "oversized body",
      request(
        { ...body, fields: { message: "x".repeat(17_000) } },
        { "content-length": "17000" },
      ),
    ],
    ["unknown envelope field", request({ ...body, executable: "<script>" })],
  ])("rejects %s without invoking the application", async (_name, input) => {
    const response = await POST(input, context);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "submission_rejected",
    });
    expect(runtimeMocks.accept).not.toHaveBeenCalled();
  });

  it.each([
    [new PublicFormRejectedError(), 400, "submission_rejected"],
    [new PublicFormConflictError(), 409, "submission_identity_conflict"],
    [
      new PublicFormUnavailableError("rate_limited"),
      429,
      "temporarily_unavailable",
    ],
    [
      new PublicFormUnavailableError("request_check_unavailable"),
      503,
      "temporarily_unavailable",
    ],
    [
      new PublicFormUnavailableError("persistence_unavailable"),
      503,
      "temporarily_unavailable",
    ],
  ])(
    "translates public outcomes without leaking operational details",
    async (error, status, publicCode) => {
      runtimeMocks.accept.mockRejectedValueOnce(error);

      const response = await POST(request(), context);

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual(
        status === 429 || status === 503
          ? { error: publicCode, retryable: true }
          : { error: publicCode },
      );
    },
  );
});
