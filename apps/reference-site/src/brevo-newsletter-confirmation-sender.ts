import type {
  NewsletterConfirmationMessage,
  NewsletterConfirmationSender,
} from "@humber-foundry/application";

const defaultBaseUrl = "https://api.brevo.com/v3";

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type BrevoSenderIdentity = Readonly<{
  id: number;
  email: string;
  name: string;
}>;

/**
 * The confirmation message a person receives after using the signup form.
 *
 * It is a transactional message, so it goes one at a time through the
 * provider's transactional endpoint rather than through a campaign. It still
 * carries the campaign legal footer, because the law that asks for a footer on
 * a campaign asks for the same footer here.
 */
export function newsletterConfirmationEmail(
  message: NewsletterConfirmationMessage,
) {
  const expires = new Date(message.expiresAt).toUTCString();
  const subject = "Please confirm your newsletter signup";
  const text = [
    "Somebody asked to add this address to our newsletter.",
    "",
    "If it was you, open this link to confirm:",
    message.confirmationUrl,
    "",
    `The link works until ${expires}.`,
    "If it was not you, ignore this message. Nothing happens without the link.",
    "",
    message.legalFooter,
  ].join("\n");
  return Object.freeze({ subject, text });
}

function retryableStatus(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

export function createBrevoNewsletterConfirmationSender({
  apiKey,
  senders,
  fetcher = fetch,
  baseUrl = defaultBaseUrl,
}: {
  apiKey: string;
  senders: Readonly<Record<string, BrevoSenderIdentity>>;
  fetcher?: Fetcher;
  baseUrl?: string;
}): NewsletterConfirmationSender {
  if (apiKey.trim() === "") throw new Error("brevo_api_key_missing");
  const endpoint = baseUrl.replace(/\/+$/u, "");

  const sender: NewsletterConfirmationSender = {
    async send(message) {
      const sender = senders[message.senderIdentityId];
      if (sender === undefined) {
        // A message with no verified sender can never be delivered. Say so once
        // rather than retry for a day.
        return { outcome: "permanent_failure" };
      }
      const { subject, text } = newsletterConfirmationEmail(message);
      let response: Response;
      try {
        response = await fetcher(`${endpoint}/smtp/email`, {
          method: "POST",
          headers: {
            accept: "application/json",
            "api-key": apiKey,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            sender: { email: sender.email, name: sender.name },
            to: [{ email: message.address }],
            subject,
            textContent: text,
            // Carries the request id back on the provider's delivery events,
            // so a bounce or a complaint can be matched to the request that
            // caused it. It is not an idempotency key, and the provider makes
            // no promise about repeats: the protection against a second message
            // is the lease on the job, which treats an outcome it never learned
            // as a failure rather than trying again.
            headers: { "X-Mailin-Custom": `foundry-confirm:${message.requestId}` },
          }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        return { outcome: "retry" };
      }
      if (response.ok) return { outcome: "sent" };
      return {
        outcome: retryableStatus(response.status) ? "retry" : "permanent_failure",
      };
    },
  };
  return Object.freeze(sender);
}
