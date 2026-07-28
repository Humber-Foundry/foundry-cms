"use client";

import { useEffect, useRef, useState } from "react";

import type {
  ContentPublication,
  ContentPublicationHistoryEntry,
  ContentPublicationStatus,
} from "@foundry/application";

import {
  loadContentPublicationHistory,
  restoreContentPublication,
} from "../src/content-publication-client";

export type PublicationRecord = ContentPublication;

export const publicationLabels: Readonly<
  Record<ContentPublicationStatus, string>
> = {
  requested: "Publish requested",
  committed: "Commit created",
  building: "Cloudflare building",
  deployed: "Deployed; verifying release",
  "verified-live": "Verified live",
  blocked: "Publish blocked",
  failed: "Publish failed",
  unknown: "Publish state unknown",
};

export function PublicationHistory({
  mutationToken,
  onMutationToken,
  onMessage,
  refreshKey,
}: {
  mutationToken: string;
  onMutationToken(value: string): void;
  onMessage(value: string): void;
  refreshKey: string;
}) {
  const [history, setHistory] = useState<
    ReadonlyArray<ContentPublicationHistoryEntry>
  >([]);
  const [historyState, setHistoryState] = useState<
    "loading" | "loaded" | "unavailable"
  >("loading");
  const [restoringPublicationId, setRestoringPublicationId] =
    useState<string | null>(null);
  const restoreAttempts = useRef(new Map<string, string>());

  useEffect(() => {
    let cancelled = false;
    setHistoryState("loading");
    void loadContentPublicationHistory()
      .then((result) => {
        if (!cancelled) {
          setHistory(result.history);
          setHistoryState("loaded");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHistoryState("unavailable");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  async function restorePublishedVersion(publicationId: string) {
    setRestoringPublicationId(publicationId);
    try {
      let idempotencyKey = restoreAttempts.current.get(publicationId);
      if (idempotencyKey === undefined) {
        idempotencyKey = crypto.randomUUID();
        restoreAttempts.current.set(publicationId, idempotencyKey);
      }
      const result = await restoreContentPublication({
        publicationId,
        mutationToken,
        idempotencyKey,
      });
      onMutationToken(result.mutationToken);
      if (
        !result.response.ok ||
        typeof result.body !== "object" ||
        result.body === null ||
        !("draft" in result.body) ||
        typeof result.body.draft !== "object" ||
        result.body.draft === null ||
        !("workspaceId" in result.body.draft) ||
        typeof result.body.draft.workspaceId !== "string"
      ) {
        throw new Error("content_publication_restore_failed");
      }
      const query = new URLSearchParams({
        workspace: result.body.draft.workspaceId,
      });
      window.location.assign(`/dash?${query.toString()}`);
    } catch {
      onMessage(
        "That published version could not be restored safely. No live content was changed.",
      );
      setRestoringPublicationId(null);
    }
  }

  return (
    <section
      className="publication-history"
      aria-labelledby="publication-history-heading"
    >
      <div>
        <h3 id="publication-history-heading">Published history</h3>
        <p>
          Durable approval, commit, build, and live-verification evidence.
          Restoring creates a new unpublished draft.
        </p>
      </div>
      {historyState === "loading" ? (
        <p>Loading publication history…</p>
      ) : historyState === "unavailable" ? (
        <p>
          Publication history is temporarily unavailable. No release
          evidence has been discarded.
        </p>
      ) : history.length === 0 ? (
        <p>No publication attempts are recorded yet.</p>
      ) : (
        <ol>
          {history.map((entry) => (
            <li key={entry.publication.id}>
              <div>
                <strong>
                  {publicationLabels[entry.publication.status]}
                </strong>
                <span>
                  Revision {entry.publication.revision ?? "—"} ·{" "}
                  {entry.publication.requestedAt ?? "Time unavailable"}
                </span>
              </div>
              <dl>
                <div>
                  <dt>Commit</dt>
                  <dd>
                    <code>
                      {entry.publication.commitSha ?? "Not created"}
                    </code>
                  </dd>
                </div>
                <div>
                  <dt>Content</dt>
                  <dd>
                    <code>{entry.approval.fingerprint.contentHash}</code>
                  </dd>
                </div>
                <div>
                  <dt>Build</dt>
                  <dd>
                    <code>
                      {entry.publication.deploymentId ?? "Not requested"}
                    </code>
                  </dd>
                </div>
              </dl>
              <ol aria-label="Release evidence">
                {entry.events.map((event, index) => (
                  <li key={`${event.occurredAt}:${event.status}:${index}`}>
                    {publicationLabels[event.status]} · {event.occurredAt}
                    {event.detail === null ? "" : ` · ${event.detail}`}
                    <span>
                      Commit {event.commitSha ?? "—"} · Build{" "}
                      {event.deploymentId ?? "—"} · Approval{" "}
                      {event.approvalFingerprint}
                    </span>
                  </li>
                ))}
              </ol>
              {entry.publication.status === "verified-live" ? (
                <button
                  type="button"
                  className="copy-button"
                  disabled={restoringPublicationId !== null}
                  onClick={() =>
                    void restorePublishedVersion(entry.publication.id)
                  }
                >
                  {restoringPublicationId === entry.publication.id
                    ? "Restoring…"
                    : "Restore as new draft"}
                </button>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
