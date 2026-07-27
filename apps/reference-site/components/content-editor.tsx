"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";

import type { ContentRevision } from "@foundry/application";
import {
  listEditableSiteFields,
  type EditableSiteField,
  type SiteDefinitionEdit,
} from "@foundry/site-definition";

import {
  contentEditorReducer,
  createContentEditorState,
} from "../src/content-editor-history";
import {
  loadContentPublication,
  refreshContentPublication,
  sendContentPublicationAttempt,
} from "../src/content-publication-client";
import { sendContentRevisionAttempt } from "../src/content-revision-client";
import {
  clearStaleEdits,
  mergeStaleRecoveryEdits,
  preserveStaleEdits,
  recoveryToForward,
  recoverStaleEdits,
  synchronizeStaleEdits,
  type StaleRecoveryConflict,
  type StaleRecoveryEdit,
} from "../src/content-editor-recovery";

type SaveResponse = ContentRevision & Readonly<{ previewUrl: string }>;
type PublicationStatus =
  | "requested"
  | "committed"
  | "building"
  | "deployed"
  | "verified-live"
  | "blocked"
  | "failed"
  | "unknown";
type PublicationRecord = Readonly<{
  id: string;
  status: PublicationStatus;
  detail: string | null;
  commitSha: string | null;
}>;

const publicationLabels: Readonly<Record<PublicationStatus, string>> = {
  requested: "Publish requested",
  committed: "Commit created",
  building: "Cloudflare building",
  deployed: "Deployed; verifying release",
  "verified-live": "Verified live",
  blocked: "Publish blocked",
  failed: "Publish failed",
  unknown: "Publish state unknown",
};

function publicationIsActive(publication: PublicationRecord): boolean {
  return !["verified-live", "blocked", "failed"].includes(publication.status);
}

function changedFields(
  persisted: ReadonlyArray<EditableSiteField>,
  working: ReadonlyArray<EditableSiteField>,
): SiteDefinitionEdit[] {
  const persistedValues = new Map(
    persisted.map((field) => [field.path, field.value]),
  );
  return working
    .filter((field) => persistedValues.get(field.path) !== field.value)
    .map(({ path, value }) => ({ path, value }));
}

export function ContentEditor({
  csrfToken,
  initialRevision,
  initialPreviewUrl,
  initialStale = false,
  activeWorkspaceUrl,
  staleRecovery,
}: {
  csrfToken: string;
  initialRevision: ContentRevision;
  initialPreviewUrl: string;
  initialStale?: boolean;
  activeWorkspaceUrl: string;
  staleRecovery?: Readonly<{
    id: string;
    sourceWorkspaceId: string;
  }>;
}) {
  const [state, dispatch] = useReducer(
    contentEditorReducer,
    createContentEditorState({
      definition: initialRevision.definition,
      revision: initialRevision.revision,
      stale: initialStale,
    }),
  );
  const [message, setMessage] = useState(
    initialStale
      ? "This workspace is based on an older production version. Start a fresh workspace to edit the current site; this draft will remain preserved."
      : "",
  );
  const [mutationToken, setMutationToken] = useState(csrfToken);
  const [previewUrl, setPreviewUrl] = useState(initialPreviewUrl);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [previewedRevision, setPreviewedRevision] = useState<number | null>(
    null,
  );
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [publication, setPublication] =
    useState<PublicationRecord | null>(null);
  const [publicationBusy, setPublicationBusy] = useState(false);
  const [publicationPollAttempt, setPublicationPollAttempt] = useState(0);
  const [recoveryConflicts, setRecoveryConflicts] = useState<
    ReadonlyArray<StaleRecoveryConflict>
  >([]);
  const pendingAttempt = useRef<{
    body: string;
    idempotencyKey: string;
  } | null>(null);
  const pendingWorkspaceAttempt = useRef<{
    body: string;
    idempotencyKey: string;
  } | null>(null);
  const pendingApprovalAttempt = useRef<{
    body: string;
    idempotencyKey: string;
  } | null>(null);
  const pendingPublicationAttempt = useRef<{
    body: string;
    idempotencyKey: string;
  } | null>(null);
  const activeRecovery = useRef(staleRecovery);
  const recoveryApplied = useRef(false);
  const recoverySyncReady = useRef(false);
  const recoveryPending = useRef<StaleRecoveryEdit[]>([]);
  const persistedFields = useMemo(
    () => listEditableSiteFields(state.persistedDefinition),
    [state.persistedDefinition],
  );
  const workingFields = useMemo(
    () => listEditableSiteFields(state.workingDefinition),
    [state.workingDefinition],
  );
  const edits = changedFields(persistedFields, workingFields);
  const groups = ["Page", "Navigation", "Footer", "SEO"] as const;
  const editorLocked =
    state.status === "saving" ||
    state.status === "stale" ||
    publicationBusy;

  useEffect(() => {
    let cancelled = false;
    void loadContentPublication({
      workspaceId: initialRevision.workspaceId,
    })
      .then((result) => {
        if (
          !cancelled &&
          typeof result === "object" &&
          result !== null &&
          "publication" in result &&
          typeof result.publication === "object" &&
          result.publication !== null
        ) {
          setPublication(
            (current) => current ?? (result.publication as PublicationRecord),
          );
        }
      })
      .catch(() => {
        // A missing publication configuration must not block draft editing.
      });
    return () => {
      cancelled = true;
    };
  }, [initialRevision.workspaceId]);

  useEffect(() => {
    if (
      publication === null ||
      !publicationIsActive(publication)
    ) {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const result = await refreshContentPublication({
          workspaceId: initialRevision.workspaceId,
          publicationId: publication.id,
          mutationToken,
        });
        if (cancelled) {
          return;
        }
        setMutationToken(result.mutationToken);
        if (
          typeof result.body === "object" &&
          result.body !== null &&
          "publication" in result.body &&
          typeof result.body.publication === "object" &&
          result.body.publication !== null &&
          !cancelled
        ) {
          setPublication(result.body.publication as PublicationRecord);
        }
      } catch {
        if (!cancelled) {
          setMessage(
            "The latest publish state could not be confirmed. The operation remains recorded; retry status shortly.",
          );
        }
      } finally {
        if (!cancelled) {
          setPublicationPollAttempt((attempt) => attempt + 1);
        }
      }
    }, 2_500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    initialRevision.workspaceId,
    mutationToken,
    publication,
    publicationPollAttempt,
  ]);

  useEffect(() => {
    if (
      staleRecovery === undefined ||
      recoveryApplied.current
    ) {
      return;
    }
    recoveryApplied.current = true;
    let recoveryStorage: Storage;
    try {
      recoveryStorage = window.localStorage;
    } catch {
      setMessage(
        "Browser recovery storage is unavailable. The fresh workspace remains usable; return to the preserved old workspace to copy unsaved edits.",
      );
      return;
    }
    const { available, recovered, conflicts } = recoverStaleEdits(
      recoveryStorage,
      staleRecovery.id,
      staleRecovery.sourceWorkspaceId,
      new Map(workingFields.map((field) => [field.path, field.value])),
    );
    if (!available) {
      setMessage(
        "Browser recovery storage is unavailable. The fresh workspace remains usable; return to the preserved old workspace to copy unsaved edits.",
      );
      return;
    }
    recoveryPending.current = [...recovered, ...conflicts];
    if (initialStale) {
      return;
    }
    for (const edit of recovered) {
      dispatch({ type: "edit", ...edit });
    }
    setRecoveryConflicts(conflicts);
    if (conflicts.length > 0) {
      setMessage(
        "Some unsaved edits overlap newer values or changed field paths. Choose how to resolve each one.",
      );
    } else if (recovered.length > 0) {
      setMessage(
        "Unsaved edits were recovered in this fresh workspace. Review and save them when ready.",
      );
    }
  }, [initialStale, staleRecovery, workingFields]);

  useEffect(() => {
    if (
      staleRecovery === undefined ||
      initialStale ||
      !recoveryApplied.current ||
      activeRecovery.current === undefined
    ) {
      return;
    }
    if (!recoverySyncReady.current) {
      recoverySyncReady.current = true;
      return;
    }
    const persistedValues = new Map(
      persistedFields.map((field) => [field.path, field.value]),
    );
    const current = edits.map((edit) => ({
      ...edit,
      baseValue: persistedValues.get(edit.path) ?? "",
    }));
    const pending = mergeStaleRecoveryEdits(
      recoveryPending.current,
      current,
      new Set(recoveryConflicts.map((conflict) => conflict.path)),
    );
    try {
      if (
        !synchronizeStaleEdits(
          window.localStorage,
          staleRecovery.id,
          staleRecovery.sourceWorkspaceId,
          pending,
        )
      ) {
        setMessage(
          "Browser recovery storage could not be updated. Keep this tab open and copy your edits before reloading.",
        );
        return;
      }
      recoveryPending.current = pending;
      if (pending.length === 0) {
        activeRecovery.current = undefined;
        window.history.replaceState(null, "", activeWorkspaceUrl);
      }
    } catch {
      setMessage(
        "Browser recovery storage could not be updated. Keep this tab open and copy your edits before reloading.",
      );
    }
  }, [
    activeWorkspaceUrl,
    edits,
    initialStale,
    persistedFields,
    recoveryConflicts,
    staleRecovery,
  ]);

  async function save() {
    if (pendingAttempt.current === null) {
      pendingAttempt.current = {
        body: JSON.stringify({
          workspaceId: initialRevision.workspaceId,
          schemaVersion: state.persistedDefinition.schemaVersion,
          baseRevision: state.persistedRevision,
          edits,
        }),
        idempotencyKey: crypto.randomUUID(),
      };
    }
    dispatch({ type: "saving" });
    setMessage("");
    const attempt = pendingAttempt.current;
    try {
      const result = await sendContentRevisionAttempt({
        attempt,
        mutationToken,
      });
      const { response, body } = result;
      setMutationToken(result.mutationToken);
      if (
        response.status === 422 &&
        typeof body === "object" &&
        body !== null &&
        "fields" in body &&
        typeof body.fields === "object" &&
        body.fields !== null
      ) {
        pendingAttempt.current = null;
        dispatch({
          type: "failed",
          errors: body.fields as Record<string, string>,
        });
        setMessage("Review the highlighted fields.");
        return;
      }
      if (
        response.status === 409 &&
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        body.error === "revision_conflict"
      ) {
        pendingAttempt.current = null;
        dispatch({
          type: "failed",
          conflict: "conflict",
          errors: {},
        });
        setMessage(
          "A newer revision exists. Reload before applying these changes.",
        );
        return;
      }
      if (
        response.status === 409 &&
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        body.error === "revision_stale"
      ) {
        const acknowledgedRevision =
          "acknowledgedRevision" in body &&
          Number.isSafeInteger(body.acknowledgedRevision) &&
          (body.acknowledgedRevision as number) >= 0
            ? (body.acknowledgedRevision as number)
            : undefined;
        pendingAttempt.current = null;
        dispatch({
          type: "failed",
          conflict: "stale",
          acknowledgedRevision,
          errors: {},
        });
        setMessage(
          acknowledgedRevision === undefined
            ? "This workspace is based on an older production version. Start a fresh workspace to edit the current site; this draft will remain preserved."
            : `Revision ${acknowledgedRevision} was saved, but the current deployment cannot render it. Start a fresh workspace to recover those edits; the saved revision remains preserved.`,
        );
        return;
      }
      if (!response.ok) {
        throw new Error("content_revision_save_failed");
      }
      const saved = body as SaveResponse;
      pendingAttempt.current = null;
      if (staleRecovery !== undefined) {
        try {
          const recoveryStorage = window.localStorage;
          if (recoveryConflicts.length === 0) {
            recoveryPending.current = [];
            activeRecovery.current = undefined;
            clearStaleEdits(
              recoveryStorage,
              staleRecovery.id,
              staleRecovery.sourceWorkspaceId,
            );
            window.history.replaceState(null, "", activeWorkspaceUrl);
          } else {
            const unresolved = recoveryConflicts.map(
              ({ path, value, baseValue }) => ({
                path,
                value,
                baseValue,
              }),
            );
            recoveryPending.current = unresolved;
            preserveStaleEdits(
              recoveryStorage,
              staleRecovery.id,
              staleRecovery.sourceWorkspaceId,
              unresolved,
            );
          }
        } catch {
          window.history.replaceState(null, "", activeWorkspaceUrl);
        }
      }
      dispatch({
        type: "saved",
        definition: saved.definition,
        revision: saved.revision,
      });
      setApprovalId(null);
      setPublication((current) =>
        current !== null && publicationIsActive(current) ? current : null,
      );
      setPreviewedRevision(null);
      pendingApprovalAttempt.current = null;
      pendingPublicationAttempt.current = null;
      setPreviewUrl(saved.previewUrl);
      setMessage(`Revision ${saved.revision} saved.`);
    } catch {
      dispatch({ type: "failed", errors: {} });
      setMessage(
        "The save result could not be confirmed. Retry to check the same request.",
      );
    }
  }

  function edit(path: string, value: string) {
    if (publicationBusy) {
      return;
    }
    pendingAttempt.current = null;
    setApprovalId(null);
    setPreviewedRevision(null);
    pendingApprovalAttempt.current = null;
    pendingPublicationAttempt.current = null;
    dispatch({ type: "edit", path, value });
  }

  function moveEditHistory(direction: "undo" | "redo") {
    if (editorLocked) {
      return;
    }
    setApprovalId(null);
    pendingApprovalAttempt.current = null;
    pendingPublicationAttempt.current = null;
    dispatch({ type: direction });
  }

  async function approveRevision() {
    pendingApprovalAttempt.current ??= {
      body: JSON.stringify({
        operation: "approve",
        workspaceId: initialRevision.workspaceId,
        revision: state.persistedRevision,
        previewConfirmed: true,
      }),
      idempotencyKey: crypto.randomUUID(),
    };
    setPublicationBusy(true);
    setMessage("");
    try {
      const result = await sendContentPublicationAttempt({
        attempt: pendingApprovalAttempt.current,
        mutationToken,
      });
      setMutationToken(result.mutationToken);
      if (
        !result.response.ok ||
        typeof result.body !== "object" ||
        result.body === null ||
        !("approval" in result.body) ||
        typeof result.body.approval !== "object" ||
        result.body.approval === null ||
        !("id" in result.body.approval) ||
        typeof result.body.approval.id !== "string"
      ) {
        throw new Error("content_approval_failed");
      }
      setApprovalId(result.body.approval.id);
      setPublication((current) =>
        current !== null && publicationIsActive(current) ? current : null,
      );
      pendingApprovalAttempt.current = null;
      setMessage(
        `Revision ${state.persistedRevision} approved. It is ready to publish while every bound input remains unchanged.`,
      );
    } catch {
      setMessage(
        "Approval could not be confirmed. Reopen the exact preview if the revision or production version changed.",
      );
    } finally {
      setPublicationBusy(false);
    }
  }

  async function publishRevision() {
    if (approvalId === null) {
      return;
    }
    pendingPublicationAttempt.current ??= {
      body: JSON.stringify({
        operation: "publish",
        workspaceId: initialRevision.workspaceId,
        approvalId,
      }),
      idempotencyKey: crypto.randomUUID(),
    };
    setPublicationBusy(true);
    setMessage("");
    try {
      const result = await sendContentPublicationAttempt({
        attempt: pendingPublicationAttempt.current,
        mutationToken,
      });
      setMutationToken(result.mutationToken);
      if (
        !result.response.ok ||
        typeof result.body !== "object" ||
        result.body === null ||
        !("publication" in result.body) ||
        typeof result.body.publication !== "object" ||
        result.body.publication === null
      ) {
        const reason =
          typeof result.body === "object" &&
          result.body !== null &&
          "error" in result.body &&
          typeof result.body.error === "string"
            ? result.body.error.replaceAll("_", " ")
            : "publish request failed";
        throw new Error(reason);
      }
      const recorded = result.body.publication as PublicationRecord;
      setPublication(recorded);
      pendingPublicationAttempt.current = null;
      setMessage(publicationLabels[recorded.status]);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? `Publish was not started: ${error.message}.`
          : "Publish was not started.",
      );
    } finally {
      setPublicationBusy(false);
    }
  }

  async function recoverEdits(destination: "current" | "fresh") {
    const forwardedRecovery =
      destination === "fresh"
        ? recoveryToForward(
            state.status === "stale",
            activeRecovery.current,
          )
        : undefined;
    const recoveryId = forwardedRecovery?.id ?? crypto.randomUUID();
    const recoverySourceWorkspaceId =
      forwardedRecovery?.sourceWorkspaceId ?? initialRevision.workspaceId;
    const persistedValues = new Map(
      persistedFields.map((field) => [field.path, field.value]),
    );
    const recoveryEdits = edits.map((edit) => ({
      ...edit,
      baseValue: persistedValues.get(edit.path) ?? "",
    }));
    const editsToPreserve =
      forwardedRecovery === undefined
        ? recoveryEdits
        : mergeStaleRecoveryEdits(
            recoveryPending.current,
            recoveryEdits,
            new Set(
              initialStale
                ? recoveryPending.current.map((edit) => edit.path)
                : recoveryConflicts.map((conflict) => conflict.path),
            ),
          );
    try {
      if (
        !preserveStaleEdits(
          window.localStorage,
          recoveryId,
          recoverySourceWorkspaceId,
          editsToPreserve,
        )
      ) {
        throw new Error("stale_edit_recovery_unavailable");
      }
      const query = new URLSearchParams({
        recovery: recoveryId,
        recoverFrom: recoverySourceWorkspaceId,
      });
      if (destination === "fresh") {
        pendingWorkspaceAttempt.current ??= {
          body: JSON.stringify({ operation: "create_workspace" }),
          idempotencyKey: crypto.randomUUID(),
        };
        setCreatingWorkspace(true);
        const result = await sendContentRevisionAttempt({
          attempt: pendingWorkspaceAttempt.current,
          mutationToken,
        });
        setMutationToken(result.mutationToken);
        if (
          !result.response.ok ||
          typeof result.body !== "object" ||
          result.body === null ||
          !("workspaceId" in result.body) ||
          typeof result.body.workspaceId !== "string" ||
          !/^workspace_[a-z0-9_]+$/u.test(result.body.workspaceId)
        ) {
          throw new Error("content_workspace_creation_failed");
        }
        query.set("workspace", result.body.workspaceId);
      } else {
        query.set("workspace", initialRevision.workspaceId);
      }
      window.location.assign(`/dash?${query.toString()}`);
    } catch {
      setCreatingWorkspace(false);
      setMessage(
        "The browser could not preserve these edits for recovery. Copy them before reloading or starting a fresh workspace.",
      );
    }
  }

  function resolveRecoveryConflict(
    conflict: StaleRecoveryConflict,
    resolution: "latest" | "mine",
  ) {
    if (resolution === "mine" && conflict.currentValue !== null) {
      edit(conflict.path, conflict.value);
    }
    const remaining = recoveryConflicts.filter(
      (candidate) => candidate.path !== conflict.path,
    );
    recoveryPending.current = recoveryPending.current.filter(
      (candidate) =>
        candidate.path !== conflict.path || resolution === "mine",
    );
    setRecoveryConflicts(remaining);
    if (staleRecovery !== undefined) {
      try {
        if (recoveryPending.current.length === 0) {
          activeRecovery.current = undefined;
          clearStaleEdits(
            window.localStorage,
            staleRecovery.id,
            staleRecovery.sourceWorkspaceId,
          );
          window.history.replaceState(null, "", activeWorkspaceUrl);
        } else {
          preserveStaleEdits(
            window.localStorage,
            staleRecovery.id,
            staleRecovery.sourceWorkspaceId,
            recoveryPending.current,
          );
        }
      } catch {
        // The in-memory choice remains usable; the durable record stays intact.
      }
    }
    setMessage(
      resolution === "mine"
        ? `Your value for ${conflict.path} is ready to save.`
        : `The latest value for ${conflict.path} was kept.`,
    );
  }

  return (
    <section className="content-editor" aria-labelledby="content-editor-heading">
      <div className="dashboard-section-heading editor-heading">
        <div>
          <h2 id="content-editor-heading">Content editor</h2>
          <p>
            Stable fields from Site Definition{" "}
            {state.workingDefinition.definitionVersion}. Saves create immutable
            revisions.
          </p>
        </div>
        <div className="editor-actions">
          <button
            type="button"
            className="copy-button"
            disabled={state.past.length === 0 || editorLocked}
            onClick={() => moveEditHistory("undo")}
          >
            Undo
          </button>
          <button
            type="button"
            className="copy-button"
            disabled={state.future.length === 0 || editorLocked}
            onClick={() => moveEditHistory("redo")}
          >
            Redo
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={
              edits.length === 0 ||
              editorLocked
            }
            onClick={save}
          >
            {state.status === "saving" ? "Saving…" : "Save revision"}
          </button>
        </div>
      </div>
      <div className="editor-status">
        <span className={`state-label state-${state.status}`}>
          Revision {state.persistedRevision} · {state.status}
        </span>
        {state.status === "stale" ? (
          <span>Saved preview unavailable for the current production version</span>
        ) : (
          <a
            href={previewUrl}
            target="_blank"
            rel="noreferrer"
            onClick={() => setPreviewedRevision(state.persistedRevision)}
          >
            Preview exact saved revision ↗
          </a>
        )}
        {state.status === "conflict" || state.status === "stale" ? (
          <button
            type="button"
            className="copy-button"
            disabled={creatingWorkspace}
            onClick={() =>
              void recoverEdits(
                state.status === "stale" ? "fresh" : "current",
              )
            }
          >
            {creatingWorkspace
              ? "Starting…"
              : state.status === "stale"
              ? "Start fresh workspace"
              : "Reload latest"}
          </button>
        ) : null}
      </div>
      {state.status !== "stale" ? (
        <div
          className="publication-actions"
          aria-label="Approve and publish exact revision"
        >
          <div>
            <strong>Publication</strong>
            <span>
              {publication === null
                ? approvalId === null
                  ? "Open and inspect the exact saved preview before approval."
                  : "Ready to publish"
                : publicationLabels[publication.status]}
            </span>
          </div>
          <button
            type="button"
            className="copy-button"
            disabled={
              publicationBusy ||
              edits.length > 0 ||
              state.status !== "saved" ||
              previewedRevision !== state.persistedRevision
            }
            onClick={() => void approveRevision()}
          >
            {publicationBusy && approvalId === null
              ? "Approving…"
              : `Approve revision ${state.persistedRevision}`}
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={
              publicationBusy ||
              approvalId === null ||
              (publication !== null && publicationIsActive(publication)) ||
              edits.length > 0 ||
              state.status !== "saved"
            }
            onClick={() => void publishRevision()}
          >
            {publicationBusy && approvalId !== null
              ? "Publishing…"
              : "Publish approved revision"}
          </button>
        </div>
      ) : null}
      <p role="status" aria-live="polite" className="editor-message">
        {message}
      </p>
      {recoveryConflicts.length > 0 ? (
        <div className="editor-recovery-conflicts" role="alert">
          <p>Resolve these changed field paths manually:</p>
          <ul>
            {recoveryConflicts.map((edit) => (
              <li key={edit.path}>
                <code>{edit.path}</code>
                {edit.reason === "changed" ? (
                  <>
                    <span>Latest: {edit.currentValue}</span>
                    <span>Your unsaved value: {edit.value}</span>
                    <span className="editor-conflict-actions">
                      <button
                        type="button"
                        className="copy-button"
                        onClick={() =>
                          resolveRecoveryConflict(edit, "latest")
                        }
                      >
                        Keep latest
                      </button>
                      <button
                        type="button"
                        className="copy-button"
                        onClick={() => resolveRecoveryConflict(edit, "mine")}
                      >
                        Use my value
                      </button>
                    </span>
                  </>
                ) : (
                  <>
                    <span>
                      This field no longer exists. Your unsaved value:{" "}
                      {edit.value}
                    </span>
                    <button
                      type="button"
                      className="copy-button"
                      onClick={() =>
                        resolveRecoveryConflict(edit, "latest")
                      }
                    >
                      I’ve copied this value
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="editor-groups">
        {groups.map((group) => (
          <fieldset key={group}>
            <legend>{group}</legend>
            {workingFields
              .filter((field) => field.group === group)
              .map((field) => (
                <label key={field.path}>
                  <span>
                    {field.label}
                    <code>{field.path}</code>
                  </span>
                  {field.multiline ? (
                    <textarea
                      rows={3}
                      disabled={editorLocked}
                      value={field.value}
                      aria-invalid={Boolean(state.errors[field.path])}
                      aria-describedby={`${field.path}-error`}
                      onChange={(event) => edit(field.path, event.target.value)}
                    />
                  ) : (
                    <input
                      disabled={editorLocked}
                      value={field.value}
                      aria-invalid={Boolean(state.errors[field.path])}
                      aria-describedby={`${field.path}-error`}
                      onChange={(event) => edit(field.path, event.target.value)}
                    />
                  )}
                  <small id={`${field.path}-error`}>
                    {state.errors[field.path] ?? ""}
                  </small>
                </label>
              ))}
          </fieldset>
        ))}
      </div>
    </section>
  );
}
