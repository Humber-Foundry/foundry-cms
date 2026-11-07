"use client";

import type { useBlogCommands } from "./use-blog-commands";

/**
 * What every Blog screen shows after it sends a change: the way to send an
 * unfinished attempt again, and the sentence the server's answer earned.
 *
 * All three screens end with this, so none of them can say a different thing
 * about the same answer. The retry sends the attempt exactly as it was built,
 * so it can never write the change twice.
 */
export function BlogCommandFeedback({
  commands,
}: {
  commands: ReturnType<typeof useBlogCommands>;
}) {
  return (
    <>
      {commands.pendingAttempt === null ? null : (
        <button
          type="button"
          className="dash-button dash-button-plain"
          disabled={commands.busy}
          onClick={() => commands.retryPendingAttempt()}
        >
          Retry the last change
        </button>
      )}
      {commands.message === "" ? null : (
        <p role="alert">{commands.message}</p>
      )}
    </>
  );
}
