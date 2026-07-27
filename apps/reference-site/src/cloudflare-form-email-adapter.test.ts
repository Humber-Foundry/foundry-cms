import { describe, expect, it, vi } from "vitest";

const messages: Array<{
  from: string;
  to: string;
  raw: ReadableStream<Uint8Array>;
}> = [];

vi.mock("cloudflare:email", () => ({
  EmailMessage: class {
    constructor(
      from: string,
      to: string,
      raw: ReadableStream<Uint8Array>,
    ) {
      messages.push({ from, to, raw });
    }
  },
}));

import {
  createPublicFormDeliveryId,
  createPublicFormId,
  createPublicFormReceiptId,
} from "@foundry/application";

import {
  createCloudflareFormEmailAdapter,
  FormEmailConfigurationError,
} from "./cloudflare-form-email-adapter";

describe("Cloudflare form email adapter", () => {
  it("can send only to the installation-configured staff destination", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const adapter = createCloudflareFormEmailAdapter({
      FOUNDRY_FORM_EMAIL: { send },
      FOUNDRY_FORM_EMAIL_FROM: "forms@example.com",
      FOUNDRY_FORM_EMAIL_RECIPIENT: "staff@example.com",
      FOUNDRY_CANONICAL_ORIGIN: "https://example.com",
    });

    await adapter.notify({
      deliveryId: createPublicFormDeliveryId("delivery-1"),
      formId: createPublicFormId("contact"),
      receiptId: createPublicFormReceiptId("receipt-1"),
      acceptedAt: "2026-07-27T20:00:00.000Z",
      previewFields: { name: "Ada" },
      dashboardPath: "/dash/forms/receipt-1",
    });

    expect(send).toHaveBeenCalledOnce();
    expect(messages.at(-1)).toMatchObject({
      from: "forms@example.com",
      to: "staff@example.com",
    });
  });

  it("fails closed without a complete fixed-recipient configuration", () => {
    expect(() =>
      createCloudflareFormEmailAdapter({
        FOUNDRY_FORM_EMAIL: { send: vi.fn() },
        FOUNDRY_FORM_EMAIL_FROM: "forms@example.com",
        FOUNDRY_CANONICAL_ORIGIN: "https://example.com",
      }),
    ).toThrow(FormEmailConfigurationError);
    expect(() =>
      createCloudflareFormEmailAdapter({
        FOUNDRY_FORM_EMAIL: { send: vi.fn() },
        FOUNDRY_FORM_EMAIL_FROM: "forms@example.com",
        FOUNDRY_FORM_EMAIL_RECIPIENT: "staff@example.com",
        FOUNDRY_CANONICAL_ORIGIN: "https://",
      }),
    ).toThrow(FormEmailConfigurationError);
  });
});
