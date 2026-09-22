"use client";

import { useEffect, useId, useRef, useState } from "react";

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

type Status =
  | { state: "loading" }
  | { state: "unavailable" }
  | { state: "ready"; siteKey: string; schemaVersion: string }
  | { state: "sending"; siteKey: string; schemaVersion: string }
  | { state: "done" }
  | {
      state: "error";
      siteKey: string;
      schemaVersion: string;
      message: string;
    };

const turnstileScript =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

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

function loadTurnstile(): Promise<void> {
  if (window.turnstile !== undefined) return Promise.resolve();
  const existing = document.querySelector<HTMLScriptElement>(
    `script[src="${turnstileScript}"]`,
  );
  if (existing !== null) {
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("turnstile")));
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = turnstileScript;
    script.async = true;
    script.addEventListener("load", () => resolve());
    script.addEventListener("error", () => reject(new Error("turnstile")));
    document.head.append(script);
  });
}

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
      ? { state: "ready", siteKey: "", schemaVersion: "" }
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
          turnstileSiteKey?: string | null;
        };
        if (cancelled) return;
        if (
          value.available !== true ||
          !value.turnstileSiteKey ||
          !value.schemaVersion
        ) {
          setStatus({ state: "unavailable" });
          return;
        }
        setStatus({
          state: "ready",
          siteKey: value.turnstileSiteKey,
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
          action: "contact",
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
  }, [previewOnly, siteKey]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // A refused try must be tryable again. `error` keeps the site key and the
    // schema version, so the form is still able to send.
    if (previewOnly || (status.state !== "ready" && status.state !== "error")) {
      return;
    }
    const { schemaVersion } = status;
    if (token.current === "") {
      setStatus({
        state: "error",
        siteKey,
        schemaVersion,
        message: "Please finish the check above, then try again.",
      });
      return;
    }
    setStatus({ state: "sending", siteKey, schemaVersion });
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion,
          submissionId: crypto.randomUUID(),
          // A blank address is left out rather than sent empty, so a stored
          // message never carries an address nobody typed.
          fields:
            email.trim() === ""
              ? { name, message }
              : { name, email, message },
          turnstileToken: token.current,
          honeypot: "",
          startedAt: startedAt.current,
        }),
      });
      if (response.status === 201) {
        setStatus({ state: "done" });
        return;
      }
      window.turnstile?.reset(widgetId.current);
      token.current = "";
      setStatus({
        state: "error",
        siteKey,
        schemaVersion,
        message:
          response.status === 429
            ? "Too many tries just now. Please wait a minute and try again."
            : "We could not send your message. Please try again.",
      });
    } catch {
      window.turnstile?.reset(widgetId.current);
      token.current = "";
      setStatus({
        state: "error",
        siteKey,
        schemaVersion,
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
