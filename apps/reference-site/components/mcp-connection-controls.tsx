"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import type { McpConnectionSummary } from "@humber-foundry/application";

import { mcpConnectionStatusDisplayLabel } from "./access-display";
import {
  mcpConnectionDisplayName,
  mcpRelativeTime,
  mcpScopeDisplay,
} from "../src/mcp-connection-display";

export function McpConnectionTable({
  connections,
  pendingId,
  onRevoke,
}: {
  connections: ReadonlyArray<McpConnectionSummary>;
  pendingId: string | null;
  onRevoke(connection: McpConnectionSummary): void;
}) {
  if (connections.length === 0) {
    return (
      <p className="empty-state">
        No agent is connected yet. Select Connect an agent to connect one.
      </p>
    );
  }

  return (
    <div className="mcp-connections">
      <div
        className="inventory-table"
        role="table"
        aria-label="Agent connections"
      >
        <div className="inventory-row inventory-head" role="row">
          <span role="columnheader">Client</span>
          <span role="columnheader">Permissions</span>
          <span role="columnheader">State</span>
          <span role="columnheader">Action</span>
        </div>
        {connections.map((connection) => (
          <div
            className="inventory-row"
            role="row"
            key={connection.connectionId}
          >
            <strong role="cell" title={connection.clientId}>
              {mcpConnectionDisplayName(connection.clientId)}
              <small>
                Created{" "}
                <time dateTime={connection.createdAt}>
                  {mcpRelativeTime(connection.createdAt)}
                </time>
              </small>
            </strong>
            <span role="cell">
              <ul className="mcp-scope-list">
                {connection.scopes.map((scope) => {
                  const display = mcpScopeDisplay(scope);
                  return (
                    <li key={scope}>
                      {display.phrase}
                      {display.known ? null : (
                        <small>
                          {" "}
                          Unrecognized permission. Shown as sent by the
                          server.
                        </small>
                      )}
                    </li>
                  );
                })}
              </ul>
            </span>
            <span role="cell" className="state-label">
              {mcpConnectionStatusDisplayLabel[connection.status]}
              <small>
                {connection.lastUsedAt === null ? (
                  "Never used"
                ) : (
                  <>
                    Last used{" "}
                    <time dateTime={connection.lastUsedAt}>
                      {mcpRelativeTime(connection.lastUsedAt)}
                    </time>
                  </>
                )}
              </small>
            </span>
            <div role="cell">
              {connection.status === "active" ? (
                <button
                  type="button"
                  disabled={pendingId !== null}
                  onClick={() => onRevoke(connection)}
                >
                  {pendingId === connection.connectionId
                    ? "Revoking…"
                    : "Revoke"}
                </button>
              ) : (
                <span>Revoked</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Asks whether to revoke one connection. A native <dialog> gives it its own
 * modal backdrop, focus handling and Escape key, matching the pattern the
 * photo picker uses, so revoke never falls back to the browser's own
 * `window.confirm`.
 */
function RevokeConfirmDialog({
  connection,
  onConfirm,
  onCancel,
}: {
  connection: McpConnectionSummary | null;
  onConfirm(): void;
  onCancel(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (connection !== null && !element.open) element.showModal();
    if (connection === null && element.open) element.close();
  }, [connection]);

  return (
    <dialog
      className="revoke-confirm-dialog"
      ref={dialog}
      aria-labelledby="revoke-confirm-title"
      onClose={onCancel}
      onCancel={onCancel}
    >
      {connection === null ? null : (
        <>
          <h2 id="revoke-confirm-title">Revoke this connection?</h2>
          <p>
            {mcpConnectionDisplayName(connection.clientId)} will lose access
            to this site at once. You can connect it again later.
          </p>
          <div className="revoke-confirm-actions">
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" onClick={onConfirm}>
              Revoke
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}

export function McpConnectionControls({
  connections,
  csrfToken,
}: {
  connections: ReadonlyArray<McpConnectionSummary>;
  csrfToken: string;
}) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [confirming, setConfirming] = useState<McpConnectionSummary | null>(
    null,
  );

  async function revoke(connection: McpConnectionSummary) {
    setConfirming(null);
    setPendingId(connection.connectionId);
    setMessage("");
    try {
      const response = await fetch(
        "/api/foundry-cms/mcp-connections/revoke",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-foundry-csrf": csrfToken,
          },
          body: JSON.stringify({
            connectionId: connection.connectionId,
            reason: "Revoked from the Owner dashboard.",
          }),
        },
      );
      if (!response.ok) {
        setMessage(
          "The connection could not be confirmed as revoked. Refresh and inspect its current state.",
        );
        return;
      }
      setMessage(
        "Connection revoked. The agent lost access to this site at once. You can connect it again later.",
      );
      router.refresh();
    } catch {
      setMessage(
        "The result is unknown. Refresh before retrying so the current connection state is checked.",
      );
    } finally {
      setPendingId(null);
    }
  }

  return (
    <>
      <p role="status" aria-live="polite">
        {message}
      </p>
      <McpConnectionTable
        connections={connections}
        pendingId={pendingId}
        onRevoke={setConfirming}
      />
      <RevokeConfirmDialog
        connection={confirming}
        onConfirm={() => {
          if (confirming !== null) void revoke(confirming);
        }}
        onCancel={() => setConfirming(null)}
      />
    </>
  );
}
