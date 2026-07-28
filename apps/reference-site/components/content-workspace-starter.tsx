"use client";

import { useRef, useState } from "react";

import type { ContentRevision } from "@foundry/application";

import { sendContentRevisionAttempt } from "../src/content-revision-client";
import {
  createContentEditorOutboxController,
  type ContentEditorOutboxRecord,
} from "../src/content-editor-outbox";
import {
  preserveStaleEdits,
  type StaleRecoveryPointer,
} from "../src/content-editor-recovery";

type CreatedWorkspace = Readonly<{ workspaceId: string }>;
type PreservedContentRevision = Readonly<{
  workspaceId: ContentRevision["workspaceId"];
  revision: ContentRevision["revision"];
  schemaVersion: ContentRevision["inputs"]["schemaVersion"];
}>;

export function workspaceCreationOperation(
  preservedRevision: PreservedContentRevision | undefined,
): "create_default_workspace" | "create_workspace" {
  return preservedRevision === undefined
    ? "create_default_workspace"
    : "create_workspace";
}

export async function preparePreservedRevisionRecovery({
  preservedRevision,
  readOutbox = async (workspaceId) =>
    createContentEditorOutboxController(workspaceId).read(
      async () => false,
    ),
  storage = window.localStorage,
  createRecoveryId = () => crypto.randomUUID(),
}: {
  preservedRevision: PreservedContentRevision | undefined;
  readOutbox?: (
    workspaceId: string,
  ) => Promise<ContentEditorOutboxRecord | null>;
  storage?: Pick<Storage, "getItem" | "removeItem" | "setItem">;
  createRecoveryId?: () => string;
}): Promise<StaleRecoveryPointer | undefined> {
  if (preservedRevision === undefined) {
    return undefined;
  }
  const record = await readOutbox(preservedRevision.workspaceId);
  if (record === null || record.edits.length === 0) {
    return undefined;
  }
  const recovery = {
    id: createRecoveryId(),
    sourceWorkspaceId: preservedRevision.workspaceId,
  };
  if (
    !preserveStaleEdits(
      storage,
      recovery.id,
      recovery.sourceWorkspaceId,
      record.edits,
    )
  ) {
    throw new Error("stale_edit_recovery_unavailable");
  }
  return recovery;
}

export function ContentWorkspaceStarter({
  csrfToken,
  staleRecovery,
  preservedRevision,
}: {
  csrfToken: string;
  staleRecovery?: Readonly<{
    id: string;
    sourceWorkspaceId: string;
  }>;
  preservedRevision?: PreservedContentRevision;
}) {
  const [message, setMessage] = useState("");
  const [starting, setStarting] = useState(false);
  const [mutationToken, setMutationToken] = useState(csrfToken);
  const pendingAttempt = useRef<{
    body: string;
    idempotencyKey: string;
  } | null>(null);
  const pendingRecovery = useRef<
    Promise<StaleRecoveryPointer | undefined> | undefined
  >(undefined);

  async function startWorkspace() {
    pendingAttempt.current ??= {
      body: JSON.stringify({
        operation: workspaceCreationOperation(preservedRevision),
      }),
      idempotencyKey: crypto.randomUUID(),
    };
    setStarting(true);
    setMessage("");
    try {
      pendingRecovery.current ??= preparePreservedRevisionRecovery({
        preservedRevision,
      }).catch((error: unknown) => {
        pendingRecovery.current = undefined;
        throw error;
      });
      const preservedOutboxRecovery = await pendingRecovery.current;
      const result = await sendContentRevisionAttempt({
        attempt: pendingAttempt.current,
        mutationToken,
      });
      setMutationToken(result.mutationToken);
      if (!result.response.ok) {
        throw new Error("content_workspace_creation_failed");
      }
      const created = result.body as CreatedWorkspace;
      if (
        typeof created.workspaceId !== "string" ||
        !/^workspace_[a-z0-9_]+$/u.test(created.workspaceId)
      ) {
        throw new Error("content_workspace_creation_invalid");
      }
      const query = new URLSearchParams({ workspace: created.workspaceId });
      if (staleRecovery !== undefined) {
        query.set("recovery", staleRecovery.id);
        query.set("recoverFrom", staleRecovery.sourceWorkspaceId);
      } else if (preservedOutboxRecovery !== undefined) {
        query.set("recovery", preservedOutboxRecovery.id);
        query.set(
          "recoverFrom",
          preservedOutboxRecovery.sourceWorkspaceId,
        );
      }
      window.location.assign(`/dash?${query.toString()}`);
    } catch {
      setStarting(false);
      setMessage(
        preservedRevision === undefined
          ? "The workspace could not be confirmed. Retry to check the same request."
          : "The fresh workspace could not be confirmed without preserving browser edits. Retry, or copy the edits from the preserved workspace before leaving it.",
      );
    }
  }

  return (
    <section
      className="content-editor"
      aria-labelledby="content-workspace-heading"
    >
      <div className="dashboard-section-heading editor-heading">
        <div>
          <h2 id="content-workspace-heading">Content editor</h2>
          {preservedRevision === undefined ? (
            <p>
              Start a private draft workspace from the current published site.
            </p>
          ) : (
            <p>
              Workspace <code>{preservedRevision.workspaceId}</code> revision{" "}
              {preservedRevision.revision} is preserved under Site Definition{" "}
              {preservedRevision.schemaVersion}. Start a fresh workspace to
              edit the current schema.
            </p>
          )}
        </div>
        <button
          type="button"
          className="button button-primary"
          disabled={starting}
          onClick={startWorkspace}
        >
          {starting
            ? "Starting…"
            : preservedRevision === undefined
              ? "Start workspace"
              : "Start fresh workspace"}
        </button>
      </div>
      <p role="status" aria-live="polite" className="editor-message">
        {message}
      </p>
    </section>
  );
}
