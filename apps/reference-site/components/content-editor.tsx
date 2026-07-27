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
import { sendContentRevisionAttempt } from "../src/content-revision-client";
import {
  clearStaleEdits,
  preserveStaleEdits,
  recoverStaleEdits,
  type StaleRecoveryConflict,
  type StaleRecoveryEdit,
} from "../src/content-editor-recovery";

type SaveResponse = ContentRevision & Readonly<{ previewUrl: string }>;

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
  const [recoveryConflicts, setRecoveryConflicts] = useState<
    ReadonlyArray<StaleRecoveryConflict>
  >([]);
  const pendingAttempt = useRef<{
    body: string;
    idempotencyKey: string;
  } | null>(null);
  const recoveryApplied = useRef(false);
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
  const editorLocked = state.status === "saving" || state.status === "stale";

  useEffect(() => {
    if (
      staleRecovery === undefined ||
      initialStale ||
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
    for (const edit of recovered) {
      dispatch({ type: "edit", ...edit });
    }
    recoveryPending.current = [...recovered, ...conflicts];
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
        pendingAttempt.current = null;
        dispatch({
          type: "failed",
          conflict: "stale",
          errors: {},
        });
        setMessage(
          "This workspace is based on an older production version. Start a fresh workspace to edit the current site; this draft will remain preserved.",
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
    pendingAttempt.current = null;
    dispatch({ type: "edit", path, value });
  }

  function recoverEdits(destination: "current" | "fresh"): void {
    const recoveryId = crypto.randomUUID();
    const persistedValues = new Map(
      persistedFields.map((field) => [field.path, field.value]),
    );
    const recoveryEdits = edits.map((edit) => ({
      ...edit,
      baseValue: persistedValues.get(edit.path) ?? "",
    }));
    try {
      if (
        !preserveStaleEdits(
          window.localStorage,
          recoveryId,
          initialRevision.workspaceId,
          recoveryEdits,
        )
      ) {
        throw new Error("stale_edit_recovery_unavailable");
      }
      const query = new URLSearchParams({
        recovery: recoveryId,
        recoverFrom: initialRevision.workspaceId,
      });
      if (destination === "fresh") {
        query.set("newWorkspace", "1");
      } else {
        query.set("workspace", initialRevision.workspaceId);
      }
      window.location.assign(`/dash?${query.toString()}`);
    } catch {
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
            onClick={() => dispatch({ type: "undo" })}
          >
            Undo
          </button>
          <button
            type="button"
            className="copy-button"
            disabled={state.future.length === 0 || editorLocked}
            onClick={() => dispatch({ type: "redo" })}
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
          <a href={previewUrl} target="_blank" rel="noreferrer">
            Preview exact saved revision ↗
          </a>
        )}
        {state.status === "conflict" || state.status === "stale" ? (
          <a
            href={
              state.status === "stale"
                ? "/dash?newWorkspace=1"
                : activeWorkspaceUrl
            }
            onClick={
              (event) => {
                event.preventDefault();
                recoverEdits(
                  state.status === "stale" ? "fresh" : "current",
                );
              }
            }
          >
            {state.status === "stale"
              ? "Start fresh workspace"
              : "Reload latest"}
          </a>
        ) : null}
      </div>
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
