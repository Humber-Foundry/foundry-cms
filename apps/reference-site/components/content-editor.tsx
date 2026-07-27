"use client";

import { useMemo, useReducer, useRef, useState } from "react";

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
}: {
  csrfToken: string;
  initialRevision: ContentRevision;
}) {
  const [state, dispatch] = useReducer(
    contentEditorReducer,
    createContentEditorState({
      definition: initialRevision.definition,
      revision: initialRevision.revision,
    }),
  );
  const [message, setMessage] = useState("");
  const [previewUrl, setPreviewUrl] = useState(
    `/preview/${initialRevision.revision}`,
  );
  const pendingAttempt = useRef<{
    body: string;
    idempotencyKey: string;
  } | null>(null);
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

  async function save() {
    if (pendingAttempt.current === null) {
      pendingAttempt.current = {
        body: JSON.stringify({
          baseRevision: state.persistedRevision,
          edits,
        }),
        idempotencyKey: crypto.randomUUID(),
      };
    }
    dispatch({ type: "saving" });
    setMessage("");
    try {
      const response = await fetch("/api/foundry-cms/revisions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": pendingAttempt.current.idempotencyKey,
          "x-foundry-csrf": csrfToken,
        },
        body: pendingAttempt.current.body,
      });
      const body: unknown = await response.json();
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
          conflict: true,
          errors: {},
        });
        setMessage(
          "A newer revision exists. Reload before applying these changes.",
        );
        return;
      }
      if (!response.ok) {
        throw new Error("content_revision_save_failed");
      }
      const saved = body as SaveResponse;
      pendingAttempt.current = null;
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
            disabled={state.past.length === 0 || state.status === "saving"}
            onClick={() => dispatch({ type: "undo" })}
          >
            Undo
          </button>
          <button
            type="button"
            className="copy-button"
            disabled={state.future.length === 0 || state.status === "saving"}
            onClick={() => dispatch({ type: "redo" })}
          >
            Redo
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={edits.length === 0 || state.status === "saving"}
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
        <a href={previewUrl} target="_blank" rel="noreferrer">
          Preview exact saved revision ↗
        </a>
        {state.status === "conflict" ? <a href="/dash">Reload latest</a> : null}
      </div>
      <p role="status" aria-live="polite" className="editor-message">
        {message}
      </p>
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
                      value={field.value}
                      aria-invalid={Boolean(state.errors[field.path])}
                      aria-describedby={`${field.path}-error`}
                      onChange={(event) => edit(field.path, event.target.value)}
                    />
                  ) : (
                    <input
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
