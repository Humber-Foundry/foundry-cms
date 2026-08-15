"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { SuspectedSpamSubmission } from "@humber-foundry/application";

import { formatDashboardMoment } from "@/src/dashboard-time";

import { applyFormOperation } from "./form-operation-request";

const outcomeMessages = {
  applied: "Accepted. It is in your inbox now.",
  refused: "That message could not be accepted. Reload and try again.",
  unconfirmed: "The result is unknown. Reload the page before trying again.",
} as const;

/**
 * The list of messages the spam check held back.
 *
 * It says when each one arrived and which form it came from, and no more:
 * reading what a held message says is an audited act, so it happens on the
 * message's own page.
 */
export function SpamReviewList({
  suspectedSpam,
  canAccept,
  pending = false,
  message = "",
  onAccept,
}: {
  suspectedSpam: ReadonlyArray<SuspectedSpamSubmission>;
  canAccept: boolean;
  pending?: boolean;
  message?: string;
  onAccept?: (receiptId: string) => void;
}) {
  if (suspectedSpam.length === 0) {
    return (
      <p className="empty-state">
        Nothing is waiting. Messages that look like spam are held here instead
        of reaching your inbox.
      </p>
    );
  }

  return (
    <>
      <p role="status" aria-live="polite">
        {message}
      </p>
      <ul className="message-list">
        {suspectedSpam.map((submission) => (
          <li className="message-item" key={submission.receiptId}>
            <a
              className="message-open"
              href={`/dash/forms/${encodeURIComponent(submission.receiptId)}`}
            >
              <span className="message-sender">Held for review</span>
              <span className="message-preview">
                Open it to read what was sent.
              </span>
              <span className="message-meta">
                {submission.formId} form ·{" "}
                {formatDashboardMoment(submission.acceptedAt)}
              </span>
            </a>
            {canAccept ? (
              <button
                className="copy-button"
                disabled={pending}
                onClick={() => onAccept?.(submission.receiptId)}
                type="button"
              >
                Not spam — accept it
              </button>
            ) : (
              <span className="message-note">The owner decides this one</span>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * Accepting a held message puts it in the inbox and sends the owner the
 * notification email that was held with it.
 */
export function SpamReviewControls({
  csrfToken,
  canAccept,
  suspectedSpam,
}: {
  csrfToken: string;
  canAccept: boolean;
  suspectedSpam: ReadonlyArray<SuspectedSpamSubmission>;
}) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  async function accept(receiptId: string) {
    setPending(true);
    setMessage("");
    const outcome = await applyFormOperation(
      { action: "release_spam", receiptId },
      csrfToken,
    );
    setMessage(outcomeMessages[outcome]);
    setPending(false);
    if (outcome === "applied") router.refresh();
  }

  return (
    <SpamReviewList
      canAccept={canAccept}
      message={message}
      onAccept={accept}
      pending={pending}
      suspectedSpam={suspectedSpam}
    />
  );
}
