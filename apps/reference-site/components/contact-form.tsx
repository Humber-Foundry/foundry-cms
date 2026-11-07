"use client";

import { useEffect, useId, useRef, useState } from "react";

import { contactFormEnvelope } from "./contact-form-envelope";
import { loadTurnstile } from "./turnstile";

/**
 * The public contact form.
 *
 * A visitor writes their name, an address to reply to, and a message. The form
 * posts to the site's own public form route, which checks the message for
 * automated traffic before it saves anything. The saved message then appears in
 * Messages in the dashboard.
 *
 * The form asks the server whether the form works before it shows anything a
 * person can fill in, the same way the newsletter signup form does. A field
 * that looks ready and then refuses every message is worse than a field that
 * waits.
 *
 * On an editing surface — the page editor and the Design preview — the form
 * sends nothing at all. See ADR-0044.
 */

/**
 * What the server said this form needs before it can send: the site key the
 * widget draws with, the action name the check must claim, and the form's
 * schema version. The server refuses a message that claims any other action,
 * so none of these is guessed here.
 */
type FormContract = Readonly<{
  siteKey: string;
  turnstileAction: string;
  schemaVersion: string;
}>;

type Status =
  | { state: "loading" }
  | { state: "unavailable" }
  | ({ state: "ready" } & FormContract)
  | ({ state: "sending" } & FormContract)
  | { state: "done" }
  | ({ state: "error"; message: string } & FormContract);

export type ContactFormProps = Readonly<{
  /** The declared public form this block sends to. */
  formId: string;
  title: string;
  body: string;
  actionLabel: string;
  /** The id the section's `aria-labelledby` points at. */
  titleId?: string;
  /** True inside the dashboard editor, where the form must not send anything. */
  previewOnly?: boolean;
}>;

export function ContactForm({
  formId,
  title,
  body,
  actionLabel,
  titleId,
  previewOnly = false,
}: ContactFormProps) {
  const nameId = useId();
  const emailId = useId();
  const messageId = useId();
  const statusId = useId();
  const [status, setStatus] = useState<Status>(
    previewOnly
      ? { state: "ready", siteKey: "", turnstileAction: "", schemaVersion: "" }
      : { state: "loading" },
  );
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const startedAt = useRef(new Date().toISOString());
  const challenge = useRef<HTMLDivElement | null>(null);
  const widgetId = useRef<string | undefined>(undefined);
  const token = useRef("");
  const endpoint = `/api/forms/${encodeURIComponent(formId)}/submissions`;

  useEffect(() => {
    if (previewOnly) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(endpoint, {
          headers: { accept: "application/json" },
        });
        const value = (await response.json()) as {
          available?: boolean;
          schemaVersion?: string | null;
          turnstileAction?: string | null;
          turnstileSiteKey?: string | null;
        };
        if (cancelled) return;
        if (
          value.available !== true ||
          !value.turnstileSiteKey ||
          !value.turnstileAction ||
          !value.schemaVersion
        ) {
          setStatus({ state: "unavailable" });
          return;
        }
        setStatus({
          state: "ready",
          siteKey: value.turnstileSiteKey,
          turnstileAction: value.turnstileAction,
          schemaVersion: value.schemaVersion,
        });
      } catch {
        if (!cancelled) setStatus({ state: "unavailable" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [endpoint, previewOnly]);

  const siteKey = "siteKey" in status ? status.siteKey : "";
  const turnstileAction =
    "turnstileAction" in status ? status.turnstileAction : "";

  useEffect(() => {
    if (previewOnly || siteKey === "" || challenge.current === null) return;
    if (widgetId.current !== undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        await loadTurnstile();
        if (cancelled || challenge.current === null) return;
        widgetId.current = window.turnstile?.render(challenge.current, {
          sitekey: siteKey,
          action: turnstileAction,
          // Flexible sizing fills the widget's container, so the check stays
          // as wide as the fields above it.
          size: "flexible",
          callback: (value: string) => {
            token.current = value;
          },
          "expired-callback": () => {
            token.current = "";
          },
        });
      } catch {
        if (!cancelled) setStatus({ state: "unavailable" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [previewOnly, siteKey, turnstileAction]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // A refused try must be tryable again. `error` keeps everything the server
    // said, so the form is still able to send.
    if (previewOnly || (status.state !== "ready" && status.state !== "error")) {
      return;
    }
    const contract: FormContract = {
      siteKey,
      turnstileAction,
      schemaVersion: status.schemaVersion,
    };
    if (token.current === "") {
      setStatus({
        state: "error",
        ...contract,
        message: "Please finish the check above, then try again.",
      });
      return;
    }
    setStatus({ state: "sending", ...contract });
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          contactFormEnvelope({
            schemaVersion: contract.schemaVersion,
            submissionId: crypto.randomUUID(),
            name,
            email,
            message,
            turnstileToken: token.current,
            startedAt: startedAt.current,
          }),
        ),
      });
      if (response.status === 201) {
        setStatus({ state: "done" });
        return;
      }
      window.turnstile?.reset(widgetId.current);
      token.current = "";
      setStatus({
        state: "error",
        ...contract,
        message:
          response.status === 429
            ? "Too many tries just now. Please wait a minute and try again."
            : response.status === 503
              ? "This form cannot take messages just now. Your words are still here — please try again later."
              : "We could not send your message. Please try again.",
      });
    } catch {
      window.turnstile?.reset(widgetId.current);
      token.current = "";
      setStatus({
        state: "error",
        ...contract,
        message: "We could not reach the server. Please try again.",
      });
    }
  }

  // Nothing can be typed until the server has said the form works.
  const busy =
    previewOnly || status.state === "loading" || status.state === "sending";

  return (
    <div className="contact-form">
      <h2 className="contact-form-title" id={titleId}>
        {title}
      </h2>
      <p className="contact-form-body">{body}</p>

      {status.state === "done" ? (
        <p className="contact-form-note" id={statusId} role="status">
          Thank you. Your message has been sent, and we will read it.
        </p>
      ) : status.state === "unavailable" ? (
        <p className="contact-form-note" id={statusId} role="status">
          This form is not ready yet, so it cannot take your message. Please try
          again later.
        </p>
      ) : (
        <form className="contact-form-fields" onSubmit={submit} noValidate>
          <label className="contact-form-label" htmlFor={nameId}>
            Your name
          </label>
          <input
            className="contact-form-input"
            id={nameId}
            name="name"
            type="text"
            autoComplete="name"
            maxLength={100}
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={busy}
          />

          <label className="contact-form-label" htmlFor={emailId}>
            Email address
          </label>
          <input
            className="contact-form-input"
            id={emailId}
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={busy}
          />

          <label className="contact-form-label" htmlFor={messageId}>
            Message
          </label>
          <textarea
            className="contact-form-input contact-form-message"
            id={messageId}
            name="message"
            rows={5}
            maxLength={2_000}
            required
            value={message}
            aria-describedby={statusId}
            onChange={(event) => setMessage(event.target.value)}
            disabled={busy}
          />

          {previewOnly ? null : (
            <div className="contact-form-check" ref={challenge} />
          )}
          <button
            className="contact-form-button"
            type="submit"
            disabled={busy}
          >
            {status.state === "sending" ? "Sending…" : actionLabel}
          </button>
          <p className="contact-form-note" id={statusId} aria-live="polite">
            {status.state === "error"
              ? status.message
              : "We use your message and your address only to reply to you."}
          </p>
          <noscript>
            <p className="contact-form-note">
              This form needs JavaScript turned on, because every message is
              checked for automated traffic before it is accepted.
            </p>
          </noscript>
        </form>
      )}
    </div>
  );
}
