import { describe, expect, it, vi } from "vitest";

import { createNewsletterSignupRequestId } from "@humber-foundry/application";

import {
  createBrevoNewsletterConfirmationSender,
  newsletterConfirmationEmail,
} from "./brevo-newsletter-confirmation-sender";

const senders = Object.freeze({
  primary: { id: 1, email: "news@example.test", name: "Studio" },
});

const message = Object.freeze({
  requestId: createNewsletterSignupRequestId("newsletter_signup-1"),
  address: "reader@example.test",
  confirmationUrl: "https://example.test/newsletter/confirm?token=abc",
  senderIdentityId: "primary",
  legalFooter: "Studio · 1 Street, Town · Contact: https://example.test/contact",
  expiresAt: "2026-03-02T10:00:00.000Z",
});

function okResponse() {
  return new Response(JSON.stringify({ messageId: "m1" }), { status: 200 });
}

describe("newsletter confirmation message", () => {
  it("carries the link and the same legal footer a campaign carries", () => {
    const email = newsletterConfirmationEmail(message);
    expect(email.text).toContain(message.confirmationUrl);
    expect(email.text).toContain(message.legalFooter);
    expect(email.subject).toBe("Please confirm your newsletter signup");
  });

  it("says plainly that nothing happens without the link", () => {
    expect(newsletterConfirmationEmail(message).text).toContain(
      "Nothing happens without the link.",
    );
  });
});

describe("brevo newsletter confirmation sender", () => {
  it("sends one transactional message to the address", async () => {
    const fetcher = vi.fn(async () => okResponse());
    const sender = createBrevoNewsletterConfirmationSender({
      apiKey: "api-key",
      senders,
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(await sender.send(message)).toStrictEqual({ outcome: "sent" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.brevo.com/v3/smtp/email");
    const body = JSON.parse(String(init.body)) as {
      to: ReadonlyArray<{ email: string }>;
      sender: { email: string };
    };
    expect(body.to).toStrictEqual([{ email: message.address }]);
    expect(body.sender.email).toBe("news@example.test");
  });

  it("gives up rather than retry when the sender identity is unknown", async () => {
    const fetcher = vi.fn(async () => okResponse());
    const sender = createBrevoNewsletterConfirmationSender({
      apiKey: "api-key",
      senders: {},
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(await sender.send(message)).toStrictEqual({
      outcome: "permanent_failure",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("asks to retry when the provider is busy or broken", async () => {
    for (const status of [408, 429, 500, 503]) {
      const sender = createBrevoNewsletterConfirmationSender({
        apiKey: "api-key",
        senders,
        fetcher: (async () =>
          new Response("", { status })) as unknown as typeof fetch,
      });
      expect(await sender.send(message)).toStrictEqual({ outcome: "retry" });
    }
  });

  it("asks to retry when the request never completes", async () => {
    const sender = createBrevoNewsletterConfirmationSender({
      apiKey: "api-key",
      senders,
      fetcher: (async () => {
        throw new Error("network");
      }) as unknown as typeof fetch,
    });
    expect(await sender.send(message)).toStrictEqual({ outcome: "retry" });
  });

  it("gives up on a refusal the provider will repeat", async () => {
    const sender = createBrevoNewsletterConfirmationSender({
      apiKey: "api-key",
      senders,
      fetcher: (async () =>
        new Response("", { status: 400 })) as unknown as typeof fetch,
    });
    expect(await sender.send(message)).toStrictEqual({
      outcome: "permanent_failure",
    });
  });

  it("refuses to start without a provider key", () => {
    expect(() =>
      createBrevoNewsletterConfirmationSender({ apiKey: "  ", senders }),
    ).toThrow("brevo_api_key_missing");
  });

  it("never puts the provider key in the request body", async () => {
    const fetcher = vi.fn(async () => okResponse());
    const sender = createBrevoNewsletterConfirmationSender({
      apiKey: "a-secret-api-key",
      senders,
      fetcher: fetcher as unknown as typeof fetch,
    });
    await sender.send(message);
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(init.body)).not.toContain("a-secret-api-key");
  });
});
