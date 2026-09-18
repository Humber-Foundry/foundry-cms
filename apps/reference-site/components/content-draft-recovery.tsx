"use client";

import { useRef, useState } from "react";

import {
  canonicalJson,
  type ContentRevision,
} from "@humber-foundry/application";
import {
  pageCompositionContract,
  type SiteDefinition,
} from "@humber-foundry/site-definition";
import { isInstalledSiteDefinition } from "../foundry/site-definition";

import { sendContentRevisionAttempt } from "../src/content-revision-client";
import { restorePreservedMedia } from "../src/content-media-recovery";
import {
  createContentEditorOutboxController,
  type ContentEditorOutboxRecord,
} from "../src/content-editor-outbox";
import {
  comparableRecoveryBaseValue,
  comparableRecoveryValue,
  preserveStaleEdits,
  recoverStaleEdits,
  upgradeLegacyRichTextRecoveryEdit,
  type StaleRecoveryPointer,
  type StaleRecoveryEdit,
} from "../src/content-editor-recovery";
import {
  mediaManifestRecoveryPath,
  mergeDurableAndOutboxRecoveryEdits,
  upgradeLegacyRecoveryEdits,
} from "../src/content-schema-recovery";

type CreatedWorkspace = Readonly<{
  workspaceId: string;
  revision: number;
  definition: SiteDefinition;
}>;
type PreservedContentRevision = Readonly<{
  workspaceId: ContentRevision["workspaceId"];
  revision: ContentRevision["revision"];
  schemaVersion: ContentRevision["inputs"]["schemaVersion"];
}>;

function fullRecoveryValue(
  edit: StaleRecoveryEdit,
  property: "baseValue" | "value",
): string {
  if (edit.path !== pageCompositionContract.slot.id) {
    return edit[property];
  }
  try {
    return canonicalJson(JSON.parse(edit[property]));
  } catch {
    return edit[property];
  }
}

function hasIdentityOnlyStructuralBase(edit: StaleRecoveryEdit): boolean {
  if (edit.path !== pageCompositionContract.slot.id) {
    return false;
  }
  try {
    const composition: unknown = JSON.parse(edit.baseValue);
    return (
      typeof composition === "object" &&
      composition !== null &&
      "components" in composition &&
      Array.isArray(composition.components) &&
      composition.components.every(
        (component) =>
          typeof component === "object" &&
          component !== null &&
          Object.keys(component).every((key) =>
            ["id", "type", "variant"].includes(key),
          ),
      )
    );
  } catch {
    return false;
  }
}

export async function preparePreservedRevisionRecovery({
  preservedRevision,
  durableRecoveryEdits = [],
  activeRecovery,
  readOutbox = async (workspaceId) =>
    createContentEditorOutboxController(workspaceId).read(
      async () => false,
    ),
  storage = window.localStorage,
  createRecoveryId = () => crypto.randomUUID(),
}: {
  preservedRevision: PreservedContentRevision;
  durableRecoveryEdits?: ReadonlyArray<StaleRecoveryEdit>;
  activeRecovery?: StaleRecoveryPointer;
  readOutbox?: (
    workspaceId: string,
  ) => Promise<ContentEditorOutboxRecord | null>;
  storage?: Pick<Storage, "getItem" | "removeItem" | "setItem">;
  createRecoveryId?: () => string;
}): Promise<StaleRecoveryPointer | undefined> {
  const record = await readOutbox(preservedRevision.workspaceId);
  const chainedRecoveryEdits =
    activeRecovery === undefined
      ? []
      : (() => {
          const chained = recoverStaleEdits(
            storage,
            activeRecovery.id,
            activeRecovery.sourceWorkspaceId,
            new Map(),
          );
          if (!chained.available) {
            throw new Error("stale_edit_recovery_unavailable");
          }
          return [...chained.recovered, ...chained.conflicts].map(
            (edit): StaleRecoveryEdit =>
              edit.format === "richText"
                ? {
                    path: edit.path,
                    format: edit.format,
                    value: edit.value,
                    baseValue: edit.baseValue,
                  }
                : {
                    path: edit.path,
                    value: edit.value,
                    baseValue: edit.baseValue,
                    ...(edit.format === undefined
                      ? {}
                      : { format: edit.format }),
                  },
          );
        })();
  const durableByPath = new Map(
    durableRecoveryEdits.map((edit) => [edit.path, edit] as const),
  );
  const durableRichTextPaths = new Set(
    durableRecoveryEdits.flatMap((edit) =>
      edit.format === "richText" ? [edit.path] : [],
    ),
  );
  const normalizeOverlay = (
    edits: ReadonlyArray<StaleRecoveryEdit>,
  ): StaleRecoveryEdit[] =>
    upgradeLegacyRecoveryEdits(edits).map((edit) =>
      upgradeLegacyRichTextRecoveryEdit(
        edit,
        durableRichTextPaths,
      ),
    );
  const rebaseOverlay = (
    edits: ReadonlyArray<StaleRecoveryEdit>,
  ): StaleRecoveryEdit[] =>
    edits.filter((edit) => {
      const durable = durableByPath.get(edit.path);
      if (durable === undefined) {
        return true;
      }
      if (
        fullRecoveryValue(edit, "value") ===
        fullRecoveryValue(durable, "value")
      ) {
        return false;
      }
      if (
        fullRecoveryValue(edit, "baseValue") !==
          fullRecoveryValue(durable, "value") &&
        !(
          hasIdentityOnlyStructuralBase(edit) &&
          comparableRecoveryBaseValue(edit) ===
            comparableRecoveryValue(durable)
        )
      ) {
        throw new Error("content_editor_recovery_revision_conflict");
      }
      return true;
    });
  if (
    record !== null &&
    record.baseRevision > preservedRevision.revision
  ) {
    throw new Error("content_editor_outbox_revision_conflict");
  }
  const safeOutboxEdits = rebaseOverlay(
    normalizeOverlay(record?.edits ?? []),
  );
  const recoveryEdits = mergeDurableAndOutboxRecoveryEdits(
    mergeDurableAndOutboxRecoveryEdits(
      durableRecoveryEdits,
      rebaseOverlay(normalizeOverlay(chainedRecoveryEdits)),
    ),
    safeOutboxEdits,
  );
  if (recoveryEdits.length === 0) {
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
      recoveryEdits,
    )
  ) {
    throw new Error("stale_edit_recovery_unavailable");
  }
  return recovery;
}

/**
 * The recovery screen for a draft that can no longer be saved, because the
 * site moved on after the draft was written.
 *
 * This is not a first-visit step. The dashboard creates the draft workspace on
 * the server, so a site owner never has to start one. The screen only appears
 * when the saved draft has to be replaced, and it always starts a separate
 * workspace so the old draft is left intact to copy from.
 *
 * `reason` decides what the screen promises. Only `older-schema` carries edits
 * out of the stored draft, so `site-updated` must not claim that it does.
 */
export function ContentDraftRecovery({
  csrfToken,
  staleRecovery,
  preservedRevision,
  durableRecoveryEdits,
  reason,
}: {
  csrfToken: string;
  staleRecovery?: Readonly<{
    id: string;
    sourceWorkspaceId: string;
  }>;
  preservedRevision: PreservedContentRevision;
  durableRecoveryEdits?: ReadonlyArray<StaleRecoveryEdit>;
  reason: "older-schema" | "site-updated";
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
      // Always a separate workspace: reopening the default one would return
      // the same draft that cannot accept changes.
      body: JSON.stringify({ operation: "create_workspace" }),
      idempotencyKey: crypto.randomUUID(),
    };
    setStarting(true);
    setMessage("");
    try {
      const mediaRecovery = durableRecoveryEdits?.find(
        ({ path }) => path === mediaManifestRecoveryPath,
      );
      pendingRecovery.current ??= preparePreservedRevisionRecovery({
        preservedRevision,
        durableRecoveryEdits: durableRecoveryEdits?.filter(
          ({ path }) => path !== mediaManifestRecoveryPath,
        ),
        activeRecovery: staleRecovery,
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
        !/^workspace_[a-z0-9_]+$/u.test(created.workspaceId) ||
        !Number.isSafeInteger(created.revision) ||
        !isInstalledSiteDefinition(created.definition)
      ) {
        throw new Error("content_workspace_creation_invalid");
      }
      const restoredMutationToken = await restorePreservedMedia({
        edit: mediaRecovery,
        created,
        mutationToken: result.mutationToken,
        idempotencyKey: pendingAttempt.current.idempotencyKey,
        onMutationToken: setMutationToken,
      });
      setMutationToken(restoredMutationToken);
      const query = new URLSearchParams({ workspace: created.workspaceId });
      if (preservedOutboxRecovery !== undefined) {
        query.set("recovery", preservedOutboxRecovery.id);
        query.set(
          "recoverFrom",
          preservedOutboxRecovery.sourceWorkspaceId,
        );
      } else if (staleRecovery !== undefined) {
        query.set("recovery", staleRecovery.id);
        query.set("recoverFrom", staleRecovery.sourceWorkspaceId);
      }
      // Starting a draft leads into editing it: from Overview that means
      // Pages; from an editing destination it means staying where you are.
      // Recovery is the exception — the page editor is what applies preserved
      // edits, so a recovering start always lands on Pages.
      const destination =
        query.has("recovery") || window.location.pathname === "/dash"
          ? "/dash/pages"
          : window.location.pathname;
      window.location.assign(`${destination}?${query.toString()}`);
    } catch {
      setStarting(false);
      setMessage(
        "The fresh draft could not be confirmed and your unsaved changes were not copied. Try again, or copy the changes out of the old draft before you leave it.",
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
          <h2 id="content-workspace-heading">Start a fresh draft</h2>
          {reason === "older-schema" ? (
            <p>
              This draft was written for an older version of your site, so it
              can no longer be saved. Start a fresh draft to carry on. The
              changes that still fit are copied across.
            </p>
          ) : (
            <p>
              Your site has been published again since this draft was written,
              so this draft can no longer be saved. Start a fresh draft to
              carry on.
            </p>
          )}
          <p>
            The old draft is kept.{" "}
            <a
              href={`/dash/pages?workspace=${encodeURIComponent(
                preservedRevision.workspaceId,
              )}`}
            >
              Open the old draft
            </a>{" "}
            to copy anything else you need.
          </p>
        </div>
        <button
          type="button"
          className="button button-primary"
          disabled={starting}
          onClick={startWorkspace}
        >
          {starting ? "Starting…" : "Start a fresh draft"}
        </button>
      </div>
      <p role="status" aria-live="polite" className="editor-message">
        {message}
      </p>
    </section>
  );
}
