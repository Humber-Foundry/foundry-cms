"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { sendHumanMutationAttempt } from "@/src/content-revision-client";
import { previewChangeReasonLimit } from "@/src/mcp-preview-review-limits";

const reviewsUrl = "/api/foundry-cms/preview-reviews";

const errorMessages: Readonly<Record<string, string>> = {
  already_decided: "Someone has already answered this draft. Reload the page.",
  preview_not_current:
    "The draft changed after this preview was made. Ask the app to prepare a new preview.",
  not_authorized: "Your account cannot approve changes to this site.",
  request_in_progress: "That answer is still being recorded. Wait a moment.",
};

function messageFor(body: unknown) {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string" &&
    body.error in errorMessages
  ) {
    return errorMessages[body.error]!;
  }
  return "That answer was not recorded. Try again.";
}

/**
 * Approve or ask for changes on one prepared draft.
 *
 * Approving is a deliberate act on the exact draft the person looked at, so
 * the Approve button stays off until the person opens the preview in this
 * session. Opening the preview is what `previewConfirmed` reports; nothing
 * here sends it on page load.
 */
export function PreviewReviewDecision({
  previewId,
  previewHref,
  mutationToken,
}: {
  previewId: string;
  previewHref: string;
  mutationToken: string;
}) {
  const router = useRouter();
  const [previewOpened, setPreviewOpened] = useState(false);
  const [askingForChanges, setAskingForChanges] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const token = useRef(mutationToken);

  async function send(body: unknown) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await sendHumanMutationAttempt({
        url: reviewsUrl,
        attempt: {
          body: JSON.stringify(body),
          idempotencyKey: crypto.randomUUID(),
        },
        mutationToken: token.current,
      });
      token.current = result.mutationToken;
      if (!result.response.ok) {
        setMessage(messageFor(result.body));
        return;
      }
      router.refresh();
    } catch {
      setMessage("That answer was not recorded. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="review-decision">
      <p className="review-decision-step">
        Open the preview to see this draft exactly as a visitor would.
      </p>
      <p className="panel-actions">
        <a
          className="button button-primary"
          href={previewHref}
          target="_blank"
          rel="noreferrer"
          onClick={() => setPreviewOpened(true)}
        >
          Open the preview
        </a>
      </p>
      {previewOpened ? null : (
        <p className="review-decision-note">
          Approve turns on after you open the preview.
        </p>
      )}
      <div className="panel-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={!previewOpened || busy}
          onClick={() =>
            send({
              operation: "approve",
              previewId,
              previewConfirmed: true,
            })
          }
        >
          Approve this draft
        </button>
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => setAskingForChanges(!askingForChanges)}
          aria-expanded={askingForChanges}
        >
          Ask for changes
        </button>
      </div>
      {askingForChanges ? (
        <div className="review-decision-changes">
          <label htmlFor="review-reason">
            Say what needs to change. The app that made this draft reads what
            you write here.
          </label>
          <textarea
            id="review-reason"
            name="reason"
            rows={4}
            maxLength={previewChangeReasonLimit}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <p className="panel-actions">
            <button
              type="button"
              className="button button-primary"
              disabled={busy || reason.trim().length === 0}
              onClick={() =>
                send({
                  operation: "request_changes",
                  previewId,
                  reason: reason.trim(),
                })
              }
            >
              Send this answer
            </button>
          </p>
        </div>
      ) : null}
      {message === null ? null : (
        <p className="review-decision-message" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
