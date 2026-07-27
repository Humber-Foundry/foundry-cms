import type {
  PublicFormNotification,
  PublicFormNotificationAdapter,
} from "@foundry/application";

type SendEmailBinding = Readonly<{
  send(message: unknown): Promise<void>;
}>;

export type CloudflareFormEmailEnvironment = Readonly<{
  FOUNDRY_FORM_EMAIL?: SendEmailBinding;
  FOUNDRY_FORM_EMAIL_FROM?: string;
  FOUNDRY_FORM_EMAIL_RECIPIENT?: string;
  FOUNDRY_CANONICAL_ORIGIN?: string;
  FOUNDRY_FORM_EMAIL_PREVIEW_FIELDS?: string;
}>;

export class FormEmailConfigurationError extends Error {
  constructor() {
    super("form_email_not_configured");
    this.name = "FormEmailConfigurationError";
  }
}

function exactEmail(value: string | undefined) {
  if (
    value === undefined ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.trim())
  ) {
    throw new FormEmailConfigurationError();
  }
  return value.trim().toLowerCase();
}

function encodeHeader(value: string) {
  return value.replaceAll(/[\r\n]/gu, "");
}

function rawMessage(
  from: string,
  to: string,
  canonicalOrigin: string,
  notification: PublicFormNotification,
) {
  const preview = Object.entries(notification.previewFields)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  const body = [
    `A ${notification.formId} form was accepted.`,
    `Accepted: ${notification.acceptedAt}`,
    `Receipt: ${notification.receiptId}`,
    preview === "" ? null : `Preview:\n${preview}`,
    `Review: ${new URL(notification.dashboardPath, canonicalOrigin)}`,
    `Delivery: ${notification.deliveryId}`,
  ]
    .filter((line) => line !== null)
    .join("\n\n");
  const bytes = new TextEncoder().encode(
    [
      `From: ${encodeHeader(from)}`,
      `To: ${encodeHeader(to)}`,
      `Subject: ${encodeHeader(`New ${notification.formId} form submission`)}`,
      `Message-ID: <${encodeHeader(notification.deliveryId)}@foundry.invalid>`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      body,
    ].join("\r\n"),
  );
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export function createCloudflareFormEmailAdapter(
  environment: CloudflareFormEmailEnvironment,
): PublicFormNotificationAdapter {
  if (environment.FOUNDRY_FORM_EMAIL === undefined) {
    throw new FormEmailConfigurationError();
  }
  const binding = environment.FOUNDRY_FORM_EMAIL;
  const from = exactEmail(environment.FOUNDRY_FORM_EMAIL_FROM);
  const recipient = exactEmail(environment.FOUNDRY_FORM_EMAIL_RECIPIENT);
  const canonicalOrigin = environment.FOUNDRY_CANONICAL_ORIGIN;
  if (
    canonicalOrigin === undefined ||
    !canonicalOrigin.startsWith("https://")
  ) {
    throw new FormEmailConfigurationError();
  }
  return {
    async notify(notification) {
      const { EmailMessage } = await import("cloudflare:email");
      await binding.send(
        new EmailMessage(
          from,
          recipient,
          rawMessage(from, recipient, canonicalOrigin, notification),
        ),
      );
      return { outcome: "sent" };
    },
    async health() {
      return "healthy";
    },
  };
}
