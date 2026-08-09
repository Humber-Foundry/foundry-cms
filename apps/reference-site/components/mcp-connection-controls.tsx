"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { McpConnectionSummary } from "@humber-foundry/application";

export function McpConnectionTable({
  connections,
  pendingId,
  onRevoke,
}: {
  connections: ReadonlyArray<McpConnectionSummary>;
  pendingId: string | null;
  onRevoke(connection: McpConnectionSummary): void;
}) {
  return (
    <div
      className="inventory-table"
      role="table"
      aria-label="Agent connections"
    >
      <div className="inventory-row inventory-head" role="row">
        <span role="columnheader">Client</span>
        <span role="columnheader">Permission</span>
        <span role="columnheader">State</span>
        <span role="columnheader">Action</span>
      </div>
      {connections.length === 0 ? (
        <p>No agent connections have been authorized.</p>
      ) : (
        connections.map((connection) => (
          <div
            className="inventory-row"
            role="row"
            key={connection.connectionId}
          >
            <strong role="cell">
              {connection.clientId}
              <small>
                Created {new Date(connection.createdAt).toLocaleString()}
              </small>
            </strong>
            <span role="cell">{connection.scopes.join(", ")}</span>
            <span role="cell" className="state-label">
              {connection.status}
              <small>
                {connection.lastUsedAt === null
                  ? "Never used"
                  : `Last used ${new Date(connection.lastUsedAt).toLocaleString()}`}
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
        ))
      )}
    </div>
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

  async function revoke(connection: McpConnectionSummary) {
    if (
      !window.confirm(
        `Revoke ${connection.clientId}? Its next MCP request will fail.`,
      )
    ) {
      return;
    }
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
      setMessage("Connection revoked. Its next MCP request will fail.");
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
        onRevoke={revoke}
      />
    </>
  );
}
