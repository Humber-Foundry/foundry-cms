"use client";

import { useRef, useState } from "react";

import type { ContentRevision } from "@foundry/application";

import { sendContentRevisionAttempt } from "../src/content-revision-client";

type CreatedWorkspace = Readonly<{ workspaceId: string }>;
type PreservedContentRevision = Readonly<{
  workspaceId: ContentRevision["workspaceId"];
  revision: ContentRevision["revision"];
  schemaVersion: ContentRevision["inputs"]["schemaVersion"];
}>;

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

  async function startWorkspace() {
    pendingAttempt.current ??= {
      body: JSON.stringify({ operation: "create_default_workspace" }),
      idempotencyKey: crypto.randomUUID(),
    };
    setStarting(true);
    setMessage("");
    try {
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
      }
      window.location.assign(`/dash?${query.toString()}`);
    } catch {
      setStarting(false);
      setMessage(
        "The workspace could not be confirmed. Retry to check the same request.",
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
