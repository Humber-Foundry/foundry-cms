/**
 * The body the contact form block sends to `/api/forms/<formId>/submissions`.
 *
 * It is one function so the form and the test that carries its send through
 * the real acceptance rules and store agree on the exact shape. A change here
 * changes both, and `contact-form-to-inbox.test.ts` fails if the route no
 * longer accepts it.
 */
export type ContactFormEnvelopeInput = Readonly<{
  schemaVersion: string;
  submissionId: string;
  name: string;
  email: string;
  message: string;
  turnstileToken: string;
  /** When the visitor first saw the form, as an ISO-8601 instant. */
  startedAt: string;
}>;

export type ContactFormEnvelope = Readonly<{
  schemaVersion: string;
  submissionId: string;
  fields: Readonly<Record<string, string>>;
  turnstileToken: string;
  honeypot: "";
  startedAt: string;
}>;

export function contactFormEnvelope(
  input: ContactFormEnvelopeInput,
): ContactFormEnvelope {
  return {
    schemaVersion: input.schemaVersion,
    submissionId: input.submissionId,
    // A blank address is left out rather than sent empty, so a stored message
    // never carries an address nobody typed.
    fields:
      input.email.trim() === ""
        ? { name: input.name, message: input.message }
        : { name: input.name, email: input.email, message: input.message },
    turnstileToken: input.turnstileToken,
    honeypot: "",
    startedAt: input.startedAt,
  };
}
