"use client";

import { useState } from "react";

import {
  sendContentRevisionAttempt,
  sendHumanMutationAttempt,
  type ContentRevisionAttempt,
} from "../src/content-revision-client";
import {
  blogMutationKey,
  blogOperationErrorCode,
  blogOperationErrorMessage,
  changeNotAcceptedMessage,
  changeNotConfirmedMessage,
} from "./blog-operations";

/**
 * The one way every Blog screen sends a change and says what came back.
 *
 * The posts list, the writing box and one post's own screen each send some of
 * the same commands (#230). Holding the busy flag, the sentence shown back,
 * the mutation token and the unfinished attempt in one place means the three
 * screens say the same words and retry the same way.
 *
 * Every accepted change reloads `returnTo`. Nothing here keeps a copy of what
 * the server holds: the screen is drawn again from the server's own answer, so
 * what the owner sees is the server's state and never this browser's memory.
 */
export function useBlogCommands({
  csrfToken,
  returnTo,
}: {
  csrfToken: string;
  /** The address to load once a change is accepted. */
  returnTo: string;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [mutationToken, setMutationToken] = useState(csrfToken);
  const [pendingAttempt, setPendingAttempt] =
    useState<ContentRevisionAttempt | null>(null);

  /**
   * Sends one post edit to the content-revisions route.
   *
   * A request whose result never arrived is kept as `pendingAttempt` and sent
   * again unchanged, so a retry can never write the change twice. Only the
   * same change reuses it: a different change builds its own attempt, or the
   * first change would be written again under the second one's name.
   */
  async function sendRevisionCommand(body: unknown, operation: string) {
    const written = JSON.stringify(body);
    const attempt =
      pendingAttempt !== null && pendingAttempt.body === written
        ? pendingAttempt
        : { body: written, idempotencyKey: blogMutationKey(operation) };
    setPendingAttempt(attempt);
    setBusy(true);
    setMessage("");
    try {
      const result = await sendContentRevisionAttempt({
        attempt,
        mutationToken,
      });
      setMutationToken(result.mutationToken);
      setPendingAttempt(null);
      if (!result.response.ok) {
        setMessage(changeNotAcceptedMessage);
        return;
      }
      window.location.assign(returnTo);
    } catch {
      setMessage(
        "The result is not yet known. Retrying sends the exact same change, so nothing is duplicated.",
      );
    } finally {
      setBusy(false);
    }
  }

  /** Sends the attempt that has not finished yet, exactly as it was built. */
  function retryPendingAttempt() {
    if (pendingAttempt === null) return;
    void sendRevisionCommand(
      JSON.parse(pendingAttempt.body),
      "retry-blog-post",
    );
  }

  /**
   * Sends one command to the blog-operations route (schedule, cancel
   * schedule, archive, restore, retry execution). On success this loads
   * `returnTo`, exactly like `sendRevisionCommand` does for the ordinary post
   * edits, so the reloaded server data always carries the exact current
   * schedule and archive state — there is no separate copy of it to go stale.
   */
  async function sendBlogOperation(body: unknown, operation: string) {
    setBusy(true);
    setMessage("");
    try {
      const result = await sendHumanMutationAttempt({
        url: "/api/foundry-cms/blog-operations",
        attempt: {
          body: JSON.stringify(body),
          idempotencyKey: blogMutationKey(operation),
        },
        mutationToken,
      });
      setMutationToken(result.mutationToken);
      if (!result.response.ok) {
        setMessage(
          blogOperationErrorMessage(blogOperationErrorCode(result.body)),
        );
        return;
      }
      window.location.assign(returnTo);
    } catch {
      setMessage(changeNotConfirmedMessage);
    } finally {
      setBusy(false);
    }
  }

  return {
    busy,
    /**
     * For a step that does not go through this hook — opening a preview, or
     * the approval a schedule needs first. Keep every control off while the
     * request is open, or a second press sends a second write under a new
     * key, and nothing collapses the two.
     */
    setBusy,
    message,
    setMessage,
    mutationToken,
    setMutationToken,
    pendingAttempt,
    sendRevisionCommand,
    sendBlogOperation,
    retryPendingAttempt,
  };
}
