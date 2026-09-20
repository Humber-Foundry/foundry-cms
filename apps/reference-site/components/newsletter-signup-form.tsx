"use client";

import { useEffect, useId, useRef, useState } from "react";

import {
  newsletterSignupSchemaVersion,
  newsletterSignupTurnstileAction,
} from "../foundry/newsletter-signup-contract";

/**
 * The public newsletter signup form.
 *
 * A visitor types an address and gets one answer: check your inbox. Nothing is
 * added to the list until they open the link in the message, so this form never
 * says whether an address is already subscribed.
 *
 * The form asks the server whether signup works before it shows anything a
 * person can fill in. When a setting is missing the form says so plainly and
 * takes no address, because an address it cannot confirm is an address it must
 * not hold.
 */

type Status =
  | { state: "loading" }
  | { state: "unavailable" }
  | { state: "ready"; siteKey: string }
  | { state: "sending"; siteKey: string }
  | { state: "done" }
  | { state: "error"; siteKey: string; message: string };

declare global {
  interface Window {
    turnstile?: {
      render(
        element: HTMLElement,
        options: Record<string, unknown>,
      ): string | undefined;
      reset(widgetId?: string): void;
    };
  }
}

const turnstileScript =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export type NewsletterSignupFormProps = Readonly<{
  title: string;
  body: string;
  consentNote: string;
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

export function NewsletterSignupForm({
  title,
  body,
  consentNote,
  actionLabel,
  titleId,
  previewOnly = false,
}: NewsletterSignupFormProps) {
  const fieldId = useId();
  const statusId = useId();
  const [status, setStatus] = useState<Status>(
    previewOnly ? { state: "ready", siteKey: "" } : { state: "loading" },
  );
  const [email, setEmail] = useState("");
  const startedAt = useRef(new Date().toISOString());
  const challenge = useRef<HTMLDivElement | null>(null);
  const widgetId = useRef<string | undefined>(undefined);
  const token = useRef("");

  useEffect(() => {
    if (previewOnly) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/newsletter/signup", {
          headers: { accept: "application/json" },
        });
        const value = (await response.json()) as {
          available?: boolean;
          turnstileSiteKey?: string | null;
        };
        if (cancelled) return;
        if (value.available !== true || !value.turnstileSiteKey) {
          setStatus({ state: "unavailable" });
          return;
        }
        setStatus({ state: "ready", siteKey: value.turnstileSiteKey });
      } catch {
        if (!cancelled) setStatus({ state: "unavailable" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [previewOnly]);

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
          action: newsletterSignupTurnstileAction,
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
    // A refused try must be tryable again. `error` keeps the site key, so the
    // form is still able to send.
    if (
      previewOnly ||
      (status.state !== "ready" && status.state !== "error")
    ) {
      return;
    }
    if (token.current === "") {
      setStatus({
        state: "error",
        siteKey,
        message: "Please finish the check above, then try again.",
      });
      return;
    }
    setStatus({ state: "sending", siteKey });
    try {
      const response = await fetch("/api/newsletter/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: newsletterSignupSchemaVersion,
          submissionId: crypto.randomUUID(),
          email,
          // The sentence on screen is sent as it stands. The server keeps it
          // only when it matches a sentence this site publishes, and records a
          // fingerprint of those exact words as the consent version.
          consentWording: consentNote,
          collectionSurface: window.location.href,
          turnstileToken: token.current,
          honeypot: "",
          startedAt: startedAt.current,
        }),
      });
      if (response.status === 202) {
        setStatus({ state: "done" });
        return;
      }
      window.turnstile?.reset(widgetId.current);
      token.current = "";
      if (response.status === 503) {
        setStatus({ state: "unavailable" });
        return;
      }
      setStatus({
        state: "error",
        siteKey,
        message:
          response.status === 429
            ? "Too many tries just now. Please wait a minute and try again."
            : "Please check the address and try again.",
      });
    } catch {
      window.turnstile?.reset(widgetId.current);
      token.current = "";
      setStatus({
        state: "error",
        siteKey,
        message: "We could not reach the server. Please try again.",
      });
    }
  }

  // Nothing can be typed until the server has said signup works. A field that
  // looks ready but does nothing is worse than a field that waits.
  const busy =
    previewOnly || status.state === "loading" || status.state === "sending";

  return (
    <div className="newsletter-signup">
      <h2 className="newsletter-signup-title" id={titleId}>
        {title}
      </h2>
      <p className="newsletter-signup-body">{body}</p>

      {status.state === "done" ? (
        <p className="newsletter-signup-note" id={statusId} role="status">
          Check your inbox. Open the link in the message to join the list.
          Nothing is added until you do.
        </p>
      ) : status.state === "unavailable" ? (
        <p className="newsletter-signup-note" id={statusId} role="status">
          Signup is not available yet. This site cannot send the confirmation
          message, so it will not take your address.
        </p>
      ) : (
        <form className="newsletter-signup-form" onSubmit={submit} noValidate>
          <label className="newsletter-signup-label" htmlFor={fieldId}>
            Email address
          </label>
          <div className="newsletter-signup-row">
            <input
              className="newsletter-signup-input"
              id={fieldId}
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              value={email}
              aria-describedby={statusId}
              onChange={(event) => setEmail(event.target.value)}
              disabled={busy}
            />
            <button
              className="newsletter-signup-button"
              type="submit"
              disabled={busy}
            >
              {status.state === "sending" ? "Sending…" : actionLabel}
            </button>
          </div>
          {previewOnly ? null : (
            <div className="newsletter-signup-check" ref={challenge} />
          )}
          <p className="newsletter-signup-note" id={statusId} aria-live="polite">
            {status.state === "error" ? status.message : consentNote}
          </p>
          <noscript>
            <p className="newsletter-signup-note">
              Signup needs JavaScript turned on, because every signup is checked
              for automated traffic before it is accepted.
            </p>
          </noscript>
        </form>
      )}
    </div>
  );
}
