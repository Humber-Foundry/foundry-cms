import { describe, expect, it, vi } from "vitest";

import { createSiteId } from "@foundry/site-definition";

import {
  createPublicFormApplication,
  createPublicFormId,
  createPublicFormReceiptId,
  PublicFormConflictError,
  PublicFormRejectedError,
  PublicFormUnavailableError,
  type PublicFormAcceptanceStore,
} from "./public-form";

const definition = {
  id: createPublicFormId("contact"),
  schemaVersion: "1.0.0",
  allowedOrigin: "https://foundry.example",
  turnstileHostname: "foundry.example",
  turnstileAction: "contact",
  fields: [
    { id: "name", required: true, maximumLength: 100 },
    { id: "message", required: true, maximumLength: 2_000 },
  ],
} as const;

function validCommand() {
  return {
    formId: "contact",
    schemaVersion: "1.0.0",
    submissionId: "00000000-0000-4000-8000-000000000046",
    fields: {
      name: "Ada",
      message: "Please tell me more.",
    },
    turnstileToken: "verified-browser-token",
    origin: "https://foundry.example",
    bodySize: 256,
    abuseKey: "rotating-hash",
    honeypot: "",
    startedAt: "2026-07-27T19:59:45.000Z",
  };
}

describe("public form acceptance", () => {
  type TestStore = Pick<PublicFormAcceptanceStore, "accept"> &
    Partial<Pick<PublicFormAcceptanceStore, "findReceipt">>;

  function createApplication({
    store,
    rateLimiter = { allow: vi.fn(async () => true) },
    turnstile = {
      verify: vi.fn(async () => ({
        success: true,
        hostname: "foundry.example",
        action: "contact",
      })),
    },
  }: {
    store: TestStore;
    rateLimiter?: { allow(input: { key: string; formId: string }): Promise<boolean> };
    turnstile?: {
      verify(input: {
        token: string;
        idempotencyKey: string;
      }): Promise<{ success: boolean; hostname?: string; action?: string }>;
    };
  }) {
    return createPublicFormApplication({
      siteId: createSiteId("site_reference"),
      definitions: [definition],
      store: {
        findReceipt: store.findReceipt ?? (async () => null),
        accept: store.accept,
      },
      rateLimiter,
      turnstile,
      clock: () => new Date("2026-07-27T20:00:00.000Z"),
      createId: (kind) =>
        `${kind}_01J00000000000000000000000`,
      hash: async () => "payload-sha256",
    });
  }

  it("returns a receipt only after the complete acceptance transaction commits", async () => {
    const sequence: string[] = [];
    const store: TestStore = {
      accept: vi.fn(async () => {
        sequence.push("committed");
        return {
          outcome: "accepted" as const,
          receiptId: createPublicFormReceiptId(
            "receipt_01J00000000000000000000000",
          ),
        };
      }),
    };
    const application = createApplication({ store });

    const result = await application.commands.accept(validCommand());
    sequence.push("returned");

    expect(sequence).toEqual(["committed", "returned"]);
    expect(result).toEqual({
      receiptId: "receipt_01J00000000000000000000000",
      replayed: false,
    });
    expect(store.accept).toHaveBeenCalledWith(
      expect.objectContaining({
        classification: "accepted",
        requestHash: "payload-sha256",
        deliveryStatus: "pending",
      }),
    );
  });

  it.each([
    ["unknown form", { formId: "unknown" }],
    ["wrong schema version", { schemaVersion: "2.0.0" }],
    ["wrong origin", { origin: "https://attacker.example" }],
    ["oversized body", { bodySize: 16_385 }],
    ["invalid submission identity", { submissionId: "retry me" }],
    ["unknown field", { fields: { name: "Ada", message: "Hello", extra: "no" } }],
    ["missing required field", { fields: { name: "Ada" } }],
    ["non-text field", { fields: { name: "Ada", message: { html: "<b>no</b>" } } }],
    ["overlong field", { fields: { name: "Ada", message: "x".repeat(2_001) } }],
    ["honeypot signal", { honeypot: "automated value" }],
  ])("rejects %s before durable acceptance", async (_name, change) => {
    const store = { accept: vi.fn() };
    const application = createApplication({ store });

    await expect(
      application.commands.accept({ ...validCommand(), ...change }),
    ).rejects.toBeInstanceOf(PublicFormRejectedError);
    expect(store.accept).not.toHaveBeenCalled();
  });

  it("fails closed when coarse rate capacity is unavailable", async () => {
    const store = { accept: vi.fn() };
    const application = createApplication({
      store,
      rateLimiter: { allow: vi.fn(async () => false) },
    });

    await expect(
      application.commands.accept(validCommand()),
    ).rejects.toMatchObject({
      code: "rate_limited",
    } satisfies Partial<PublicFormUnavailableError>);
    expect(store.accept).not.toHaveBeenCalled();
  });

  it("fails closed when the coarse rate service cannot answer", async () => {
    const store = { accept: vi.fn() };
    const application = createApplication({
      store,
      rateLimiter: {
        allow: vi.fn(async () => {
          throw new Error("rate service unavailable");
        }),
      },
    });

    await expect(
      application.commands.accept(validCommand()),
    ).rejects.toMatchObject({
      code: "request_check_unavailable",
    } satisfies Partial<PublicFormUnavailableError>);
    expect(store.accept).not.toHaveBeenCalled();
  });

  it.each([
    { success: true, hostname: "attacker.example", action: "contact" },
    { success: true, hostname: "foundry.example", action: "other" },
  ])("rejects an invalid Turnstile result: $result", async (result) => {
    const store = { accept: vi.fn() };
    const application = createApplication({
      store,
      turnstile: { verify: vi.fn(async () => result) },
    });

    await expect(
      application.commands.accept(validCommand()),
    ).rejects.toBeInstanceOf(PublicFormRejectedError);
    expect(store.accept).not.toHaveBeenCalled();
  });

  it("reports a failed Turnstile challenge as retryable without accepting", async () => {
    const store = { accept: vi.fn() };
    const application = createApplication({
      store,
      turnstile: { verify: vi.fn(async () => ({ success: false })) },
    });

    await expect(
      application.commands.accept(validCommand()),
    ).rejects.toMatchObject({
      code: "request_check_unavailable",
    } satisfies Partial<PublicFormUnavailableError>);
    expect(store.accept).not.toHaveBeenCalled();
  });

  it("reports Turnstile outages as retryable without accepting", async () => {
    const store = { accept: vi.fn() };
    const application = createApplication({
      store,
      turnstile: {
        verify: vi.fn(async () => {
          throw new Error("provider unavailable");
        }),
      },
    });

    await expect(
      application.commands.accept(validCommand()),
    ).rejects.toMatchObject({
      code: "request_check_unavailable",
    } satisfies Partial<PublicFormUnavailableError>);
    expect(store.accept).not.toHaveBeenCalled();
  });

  it("retains borderline abuse for review without staff delivery", async () => {
    const store: TestStore = {
      accept: vi.fn(async (acceptance) => ({
        outcome: "accepted" as const,
        receiptId: acceptance.receiptId,
      })),
    };
    const application = createApplication({ store });

    await application.commands.accept({
      ...validCommand(),
      fields: {
        name: "Ada",
        message:
          "https://one.example https://two.example https://three.example",
      },
    });

    expect(store.accept).toHaveBeenCalledWith(
      expect.objectContaining({
        classification: "suspected_spam",
        deliveryStatus: "held",
      }),
    );
  });

  it("replays the original receipt without duplicating durable acceptance", async () => {
    const store: TestStore = {
      accept: vi.fn(async () => ({
        outcome: "replayed" as const,
        receiptId: createPublicFormReceiptId("receipt_original"),
      })),
    };
    const application = createApplication({ store });

    await expect(
      application.commands.accept(validCommand()),
    ).resolves.toEqual({
      receiptId: "receipt_original",
      replayed: true,
    });
  });

  it("replays a durable receipt before reusing the single-use Turnstile token", async () => {
    const rateLimiter = { allow: vi.fn(async () => true) };
    const turnstile = {
      verify: vi.fn(async () => ({
        success: false,
        hostname: "foundry.example",
        action: "contact",
      })),
    };
    const store: TestStore = {
      findReceipt: vi.fn(async () => ({
        outcome: "replayed" as const,
        receiptId: createPublicFormReceiptId("receipt_original"),
      })),
      accept: vi.fn(),
    };
    const application = createApplication({
      store,
      rateLimiter,
      turnstile,
    });

    await expect(
      application.commands.accept(validCommand()),
    ).resolves.toEqual({
      receiptId: "receipt_original",
      replayed: true,
    });
    expect(rateLimiter.allow).toHaveBeenCalledOnce();
    expect(turnstile.verify).not.toHaveBeenCalled();
    expect(store.accept).not.toHaveBeenCalled();
  });

  it("reports persistence failures without claiming acceptance", async () => {
    const store: TestStore = {
      accept: vi.fn(async () => {
        throw new Error("D1 quota exhausted");
      }),
    };
    const application = createApplication({ store });

    await expect(
      application.commands.accept(validCommand()),
    ).rejects.toMatchObject({
      code: "persistence_unavailable",
    } satisfies Partial<PublicFormUnavailableError>);
  });

  it("rejects reuse of a submission identity for different content", async () => {
    const store: TestStore = {
      accept: vi.fn(async () => ({ outcome: "conflict" as const })),
    };
    const application = createApplication({ store });

    await expect(
      application.commands.accept(validCommand()),
    ).rejects.toBeInstanceOf(PublicFormConflictError);
  });
});
