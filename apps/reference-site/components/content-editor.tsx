"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import type { ContentRevision } from "@humber-foundry/application";
import {
  listEditableSiteFields,
  pageCompositionContract,
  toPageComposition,
  toPageCompositionIdentity,
  updateEditableSiteField,
  type EditableSiteField,
  type SiteDefinitionEdit,
} from "@humber-foundry/site-definition";

import {
  contentEditorReducer,
  contentEditorStatusLocked,
  createContentEditorState,
} from "../src/content-editor-history";
import {
  contentPublicationCanRetry,
  contentPublicationHistoryRefreshKey,
  contentPublicationPollDelay,
  loadContentPublication,
  refreshContentPublication,
  sendContentPublicationAttempt,
} from "../src/content-publication-client";
import { sendContentRevisionAttempt } from "../src/content-revision-client";
import {
  applyStructuralRecovery,
  clearStaleEdits,
  comparableRecoveryBaseValue,
  comparableRecoveryValue,
  excludeCompositionOwnedEdits,
  mergeStaleRecoveryEdits,
  mergeRecoverySources,
  planStructuralFirstRecovery,
  preserveStaleEdits,
  recoveryToForward,
  recoverStaleEdits,
  resolveStructuralRecovery,
  synchronizeStaleEdits,
  upgradeLegacyRichTextRecoveryEdit,
  type StaleRecoveryConflict,
  type StaleRecoveryEdit,
} from "../src/content-editor-recovery";
import { installedPageComponentRegistry } from "../foundry/page-components";
import {
  outboxAttemptMatchesWorkspace,
  useContentEditorAutosave,
  useContentEditorPersistence,
} from "../src/content-editor-persistence";
import { pageCompositionChanged } from "../src/page-composition-puck";
import { RichTextEditor } from "./rich-text-editor";
import {
  PublicationHistory,
  publicationLabels,
  type PublicationRecord,
} from "./publication-history";
import { SiteRenderer } from "./site-renderer";
import { VisualComponentEditor } from "./visual-component-editor";

/**
 * Reading mode: in-page anchors work; any click that would leave the editor —
 * including a middle-click opening a new tab — is stopped. Switching to Edit
 * is the way to change where a link goes.
 */
function blockBrowseNavigation(event: React.MouseEvent) {
  const anchor = (event.target as HTMLElement).closest?.("a");
  if (anchor === null || anchor === undefined) return;
  const href = anchor.getAttribute("href") ?? "";
  if (href.startsWith("#")) return;
  event.preventDefault();
}

type SaveResponse = ContentRevision & Readonly<{ previewUrl: string }>;

/**
 * The field groups the Site Definition exposes. Each dashboard destination
 * renders a subset, so the owner sees only the fields for the job they opened.
 */
export const allEditableFieldGroups = [
  "Design",
  "Page",
  "Navigation",
  "Footer",
  "SEO",
  "Blog",
] as const;

export type EditableFieldGroup = (typeof allEditableFieldGroups)[number];

/** Everything that changes what a page says, without the design tokens. */
export const pageFieldGroups = [
  "Page",
  "Navigation",
  "Footer",
  "SEO",
] as const satisfies ReadonlyArray<EditableFieldGroup>;

/** The controlled design primitives: typography, colour, spacing, width. */
export const designFieldGroups = [
  "Design",
] as const satisfies ReadonlyArray<EditableFieldGroup>;

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
    .filter(
      (field) =>
        JSON.stringify(persistedValues.get(field.path)) !==
        JSON.stringify(field.value),
    )
    .map((field): SiteDefinitionEdit =>
      field.format === "richText"
        ? { path: field.path, format: "richText", value: field.value }
        : { path: field.path, format: "plainText", value: field.value },
    );
}

export function ContentEditor({
  csrfToken,
  initialRevision,
  initialPreviewUrl,
  initialStale = false,
  activeWorkspaceUrl,
  staleRecovery,
  revisionHead = initialRevision,
  revisionHeadPreviewUrl = initialPreviewUrl,
  onRevisionSaved = () => undefined,
  onContentStale = () => undefined,
  heading = "Content editor",
  fieldGroups = allEditableFieldGroups,
  showComposition = true,
  showPublicationHistory = true,
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
  revisionHead?: ContentRevision;
  revisionHeadPreviewUrl?: string;
  onRevisionSaved?(revision: ContentRevision, previewUrl: string): void;
  onContentStale?(): void;
  mediaAccessToken?: string;
  /** The accessible name for this editing surface, e.g. "Pages" or "Design". */
  heading?: string;
  /**
   * Which field groups this destination shows. Pages and Design edit the same
   * revision through the same save and publish controls; they differ only in
   * which fields they put in front of the owner.
   */
  fieldGroups?: ReadonlyArray<EditableFieldGroup>;
  /** The visual page canvas belongs to Pages, not to Design or Blog. */
  showComposition?: boolean;
  showPublicationHistory?: boolean;
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
  // The page opens in browse mode: the site reads and scrolls as itself, with
  // no editing chrome, until the owner deliberately switches to editing.
  const [editorMode, setEditorMode] = useState<"browse" | "edit">("browse");

  // The full-window editor covers the dashboard chrome; anything under the
  // overlay leaves the keyboard and screen-reader order unless made inert.
  useEffect(() => {
    if (!showComposition) return;
    const covered = document.querySelectorAll(
      ".dashboard-header, .dashboard-nav",
    );
    covered.forEach((element) => element.setAttribute("inert", ""));
    return () =>
      covered.forEach((element) => element.removeAttribute("inert"));
  }, [showComposition]);
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
  const [openingPreview, setOpeningPreview] = useState(false);
  const [invalidRichTextSources, setInvalidRichTextSources] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const hasInvalidRichText = invalidRichTextSources.size > 0;
  // Anything but "saved" means the working definition holds edits the saved
  // revision does not: "dirty" and "saving" while a save is pending,
  // "conflict" while another session's revision has landed underneath, and
  // "stale" when the whole workspace is behind production.
  const hasUnsavedChanges = state.status !== "saved";
  const [recoveryConflicts, setRecoveryConflicts] = useState<
    ReadonlyArray<StaleRecoveryConflict>
  >([]);
  const pendingWorkspaceAttempt = useRef<{
    body: string;
    idempotencyKey: string;
  } | null>(null);
  const pendingApprovalAttempt = useRef<{
    body: string;
    idempotencyKey: string;
    revision: number;
  } | null>(null);
  const pendingPublicationAttempt = useRef<{
    body: string;
    idempotencyKey: string;
  } | null>(null);
  const pendingDeploymentRetryAttempt = useRef<{
    body: string;
    idempotencyKey: string;
  } | null>(null);
  const activeRecovery = useRef(staleRecovery);
  const recoveryApplied = useRef(false);
  const recoverySyncReady = useRef(false);
  const recoveryPending = useRef<StaleRecoveryEdit[]>([]);
  const [recoverySourcesReady, setRecoverySourcesReady] = useState(
    staleRecovery === undefined,
  );
  const saveInFlight = useRef(false);
  const latestRevisionHead = useRef(revisionHead.revision);
  latestRevisionHead.current = revisionHead.revision;
  const persistedFields = useMemo(
    () => listEditableSiteFields(state.persistedDefinition),
    [state.persistedDefinition],
  );
  useEffect(() => {
    setPreviewUrl(revisionHeadPreviewUrl);
  }, [revisionHeadPreviewUrl]);
  const workingFields = useMemo(
    () => listEditableSiteFields(state.workingDefinition),
    [state.workingDefinition],
  );
  const richTextPaths = useMemo(
    () =>
      new Set(
        workingFields
          .filter((field) => field.format === "richText")
          .map((field) => field.path),
      ),
    [workingFields],
  );
  const edits = useMemo(
    () => changedFields(persistedFields, workingFields),
    [persistedFields, workingFields],
  );
  const composition = useMemo(
    () =>
      pageCompositionChanged(
        state.persistedDefinition,
        state.workingDefinition,
      )
        ? toPageComposition(state.workingDefinition)
        : undefined,
    [state.persistedDefinition, state.workingDefinition],
  );
  const recoverableEdits = useMemo<StaleRecoveryEdit[]>(
    () => {
      const fieldEdits = edits.map((edit) => ({
        ...edit,
        baseValue:
          persistedFields.find((field) => field.path === edit.path)?.value ??
          "",
      }));
      return composition === undefined
        ? fieldEdits
        : [
            {
              path: pageCompositionContract.slot.id,
              value: JSON.stringify(composition),
              baseValue: JSON.stringify(
                toPageComposition(state.persistedDefinition),
              ),
            },
            ...excludeCompositionOwnedEdits(
              fieldEdits,
              composition.components.filter(
                (component) =>
                  !state.persistedDefinition.home.sections.some(
                    ({ id }) => id === component.id,
                  ),
              ),
            ),
          ];
    },
    [composition, edits, persistedFields, state.persistedDefinition],
  );
  const persistence = useContentEditorPersistence({
    workspaceId: initialRevision.workspaceId,
    baseRevision: state.persistedRevision,
    edits: recoverableEdits,
    editorStatus: state.status,
    recoveryBlocked: recoveryConflicts.length > 0,
    onStorageError: setMessage,
  });
  const discardPersistenceAttempt = useRef(persistence.discardAttempt);
  discardPersistenceAttempt.current = persistence.discardAttempt;
  const updateRichTextValidation = useCallback(
    (source: string, invalid: boolean) => {
      setInvalidRichTextSources((current) => {
        if (current.has(source) === invalid) {
          return current;
        }
        const next = new Set(current);
        if (invalid) {
          next.add(source);
        } else {
          next.delete(source);
        }
        return next;
      });
      if (!invalid) {
        return;
      }
      discardPersistenceAttempt.current();
      setApprovalId(null);
      setPreviewedRevision(null);
      pendingApprovalAttempt.current = null;
      pendingPublicationAttempt.current = null;
    },
    [],
  );
  const updateVisualRichTextValidation = useCallback(
    (source: string, invalid: boolean) =>
      updateRichTextValidation(`visual:${source}`, invalid),
    [updateRichTextValidation],
  );
  const groups = fieldGroups;
  const editorLocked =
    !persistence.coordinated ||
    !persistence.ready ||
    contentEditorStatusLocked(state.status) ||
    recoveryConflicts.length > 0 ||
    publicationBusy;

  useEffect(() => {
    if (revisionHead.revision > state.persistedRevision) {
      persistence.discardAttempt();
      dispatch({
        type: "externalRevision",
        definition: revisionHead.definition,
        revision: revisionHead.revision,
      });
      setApprovalId(null);
      setPublication((current) =>
        current !== null && publicationIsActive(current) ? current : null,
      );
      setPreviewedRevision(null);
      pendingApprovalAttempt.current = null;
      pendingPublicationAttempt.current = null;
      pendingDeploymentRetryAttempt.current = null;
    }
  }, [persistence, revisionHead, state.persistedRevision]);

  useEffect(() => {
    if (state.status !== "saving") {
      saveInFlight.current = false;
    }
  }, [state.status]);

  function preserveOutboxWithoutAttempt(): void {
    void persistence
      .preserveWithoutAttempt()
      .catch(() => {
        setMessage(
          "Browser recovery storage could not be updated. Keep this tab open until these edits are resolved.",
        );
      });
  }

  useEffect(() => {
    let cancelled = false;
    void persistence
      .read()
      .then((record) => {
        if (cancelled || record === null || record.edits.length === 0) {
          return;
        }
        const recoveredEdits = record.edits.map((edit) =>
          upgradeLegacyRichTextRecoveryEdit(edit, richTextPaths),
        );
        recoveryPending.current = mergeRecoverySources(
          recoveryPending.current,
          recoveredEdits,
        );
        if (initialStale) {
          setMessage(
            "Unsaved browser edits were recovered. Start a fresh workspace to carry them forward.",
          );
          return;
        }
        const {
          orderedEdits,
          destinationValues: currentValues,
        } = planStructuralFirstRecovery(
          state.workingDefinition,
          recoveredEdits,
        );
        const conflicts: StaleRecoveryConflict[] = [];
        let recoveredCount = 0;
        let alreadyAppliedCount = 0;
        let recoveryDefinition = state.workingDefinition;
        for (const edit of orderedEdits) {
          const currentValue = currentValues.get(edit.path);
          if (currentValue === undefined) {
            conflicts.push({
              ...edit,
              currentValue: null,
              reason: "missing",
            });
            continue;
          }
          if (currentValue === comparableRecoveryValue(edit)) {
            alreadyAppliedCount += 1;
            continue;
          }
          if (currentValue !== comparableRecoveryBaseValue(edit)) {
            conflicts.push({
              ...edit,
              currentValue,
              reason: "changed",
            });
            continue;
          }
          if (edit.path === pageCompositionContract.slot.id) {
            const result = applyStructuralRecovery(
              recoveryDefinition,
              edit,
            );
            if (result.ok) {
              recoveryDefinition = result.definition;
              dispatch({
                type: "compose",
                definition: result.definition,
                refreshProjection: true,
              });
              recoveredCount += 1;
            } else {
              conflicts.push({
                ...edit,
                currentValue,
                reason: "changed",
              });
            }
          } else {
            const updatedDefinition = updateEditableSiteField(
              recoveryDefinition,
              edit,
            );
            if (updatedDefinition === null) {
              conflicts.push({
                ...edit,
                currentValue,
                reason: "changed",
              });
            } else {
              recoveryDefinition = updatedDefinition;
              dispatch({ type: "edit", ...edit });
              recoveredCount += 1;
            }
          }
        }
        if (alreadyAppliedCount === orderedEdits.length) {
          recoveryPending.current = [];
          void persistence.clear();
          setMessage(
            "Your last unsaved edits were already in this draft.",
          );
          return;
        }
        setRecoveryConflicts(conflicts);
        if (
          conflicts.length === 0 &&
          record.baseRevision === state.persistedRevision &&
          outboxAttemptMatchesWorkspace(
            record,
            initialRevision.workspaceId,
          )
        ) {
          persistence.restoreAttempt(record.attempt!);
        }
        if (conflicts.length > 0) {
          setMessage(
            "Unsaved browser edits were recovered, but some overlap newer values. Resolve each one before saving.",
          );
        } else if (recoveredCount > 0) {
          setMessage(
            record.baseRevision === state.persistedRevision
              ? "Unsaved browser edits were recovered. Review and save them when ready."
              : "Unsaved browser edits were safely rebased onto the latest revision. Review and save them when ready.",
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMessage(
            "Browser recovery storage is unavailable. Keep this tab open until your edits are saved.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          persistence.finishHydration();
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
    pendingDeploymentRetryAttempt.current = null;
  }, [publication?.id]);

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
    }, contentPublicationPollDelay(publicationPollAttempt));
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
      !persistence.coordinated ||
      !persistence.ready ||
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
      setRecoverySourcesReady(true);
      setMessage(
        "Browser recovery storage is unavailable. The fresh workspace remains usable; return to the preserved old workspace to copy unsaved edits.",
      );
      return;
    }
    const destinationValues = new Map([
      ...workingFields.map(
        (field) => [field.path, field.value] as const,
      ),
      [
        pageCompositionContract.slot.id,
        JSON.stringify(
          toPageCompositionIdentity(state.workingDefinition, installedPageComponentRegistry),
        ),
      ] as const,
    ]);
    let recovery = recoverStaleEdits(
      recoveryStorage,
      staleRecovery.id,
      staleRecovery.sourceWorkspaceId,
      destinationValues,
      richTextPaths,
    );
    if (!recovery.available) {
      setRecoverySourcesReady(true);
      setMessage(
        "Browser recovery storage is unavailable. The fresh workspace remains usable; return to the preserved old workspace to copy unsaved edits.",
      );
      return;
    }
    if (initialStale) {
      recoveryPending.current = mergeRecoverySources(
        recoveryPending.current,
        [...recovery.recovered, ...recovery.conflicts],
      );
      setRecoverySourcesReady(true);
      return;
    }
    const projectedRecovery = planStructuralFirstRecovery(
      state.workingDefinition,
      recovery.recovered,
    );
    if (projectedRecovery.projected) {
      recovery = recoverStaleEdits(
        recoveryStorage,
        staleRecovery.id,
        staleRecovery.sourceWorkspaceId,
        projectedRecovery.destinationValues,
        richTextPaths,
      );
      if (!recovery.available) {
        setRecoverySourcesReady(true);
        setMessage(
          "Browser recovery storage is unavailable. The fresh workspace remains usable; return to the preserved old workspace to copy unsaved edits.",
        );
        return;
      }
    }
    const applied: StaleRecoveryEdit[] = [];
    const nextConflicts = [...recovery.conflicts];
    const { orderedEdits: orderedRecovered } =
      planStructuralFirstRecovery(
        state.workingDefinition,
        recovery.recovered,
      );
    let recoveryDefinition = state.workingDefinition;
    for (const edit of orderedRecovered) {
      if (edit.path === pageCompositionContract.slot.id) {
        const result = resolveStructuralRecovery(
          recoveryDefinition,
          edit,
          destinationValues.get(edit.path) ?? null,
        );
        if (result.ok) {
          applied.push(edit);
          recoveryDefinition = result.definition;
          dispatch({
            type: "compose",
            definition: result.definition,
            refreshProjection: true,
          });
        } else {
          nextConflicts.push(result.conflict);
        }
      } else {
        const updatedDefinition = updateEditableSiteField(
          recoveryDefinition,
          edit,
        );
        if (updatedDefinition === null) {
          nextConflicts.push({
            ...edit,
            currentValue: destinationValues.get(edit.path) ?? null,
            reason: "changed",
          });
        } else {
          applied.push(edit);
          recoveryDefinition = updatedDefinition;
          dispatch({ type: "edit", ...edit });
        }
      }
    }
    recoveryPending.current = mergeRecoverySources(
      recoveryPending.current,
      [...applied, ...nextConflicts],
    );
    setRecoveryConflicts(nextConflicts);
    if (nextConflicts.length > 0) {
      setMessage(
        "Some unsaved edits overlap newer values or changed field paths. Choose how to resolve each one.",
      );
    } else if (applied.length > 0) {
      setMessage(
        "Unsaved edits were recovered in this fresh workspace. Review and save them when ready.",
      );
    }
    setRecoverySourcesReady(true);
  }, [
    initialStale,
    persistence.coordinated,
    persistence.ready,
    staleRecovery,
    workingFields,
  ]);

  useEffect(() => {
    if (
      !persistence.coordinated ||
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
    const pending = mergeStaleRecoveryEdits(
      recoveryPending.current,
      recoverableEdits,
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
    recoverableEdits,
    initialStale,
    persistence.coordinated,
    persistedFields,
    recoveryConflicts,
    staleRecovery,
  ]);

  function startSave(): boolean {
    if (
      hasInvalidRichText ||
      saveInFlight.current ||
      !persistence.coordinated ||
      !persistence.ready ||
      contentEditorStatusLocked(state.status)
    ) {
      return false;
    }
    void save();
    return true;
  }

  async function save() {
    if (saveInFlight.current) {
      return;
    }
    saveInFlight.current = true;
    dispatch({ type: "saving" });
    const attempt = await persistence.beginAttempt(
      JSON.stringify({
        workspaceId: initialRevision.workspaceId,
        schemaVersion: state.persistedDefinition.schemaVersion,
        baseRevision: state.persistedRevision,
        edits,
        ...(composition === undefined ? {} : { composition }),
      }),
    );
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
        preserveOutboxWithoutAttempt();
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
        preserveOutboxWithoutAttempt();
        dispatch({
          type: "failed",
          conflict: "conflict",
          errors: {},
        });
        setMessage(
          "This draft changed somewhere else — maybe in another tab. Reload the latest before continuing.",
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
        preserveOutboxWithoutAttempt();
        dispatch({
          type: "failed",
          conflict: "stale",
          acknowledgedRevision,
          errors: {},
        });
        onContentStale();
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
      let outboxCleared = true;
      try {
        await persistence.acknowledge();
      } catch {
        outboxCleared = false;
      }
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
              ({ currentValue: _currentValue, reason: _reason, ...edit }) =>
                edit,
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
      pendingDeploymentRetryAttempt.current = null;
      onRevisionSaved(saved, saved.previewUrl);
      setMessage(
        outboxCleared
          ? ""
          : "Saved, but this browser could not clear its local recovery copy.",
      );
    } catch {
      dispatch({ type: "failed", errors: {} });
      setMessage(
        "The save did not finish. Press Save to try again — the same change is sent, so nothing is duplicated.",
      );
    }
  }

  async function openPreview() {
    if (hasInvalidRichText) {
      return;
    }
    const popup = window.open("", "_blank");
    if (popup !== null) popup.opener = null;
    setOpeningPreview(true);
    try {
      const result = await sendContentRevisionAttempt({
        attempt: {
          body: JSON.stringify({
            operation: "open_preview",
            workspaceId: initialRevision.workspaceId,
            revision: state.persistedRevision,
          }),
          idempotencyKey: crypto.randomUUID(),
        },
        mutationToken,
      });
      setMutationToken(result.mutationToken);
      if (
        !result.response.ok ||
        typeof result.body !== "object" ||
        result.body === null ||
        !("previewUrl" in result.body) ||
        typeof result.body.previewUrl !== "string"
      ) {
        throw new Error("preview_access_grant_failed");
      }
      setPreviewedRevision(state.persistedRevision);
      if (popup === null) {
        window.open(result.body.previewUrl, "_blank", "noopener,noreferrer");
      } else {
        popup.location.href = result.body.previewUrl;
      }
    } catch {
      popup?.close();
      setMessage("The preview could not be opened. Try again.");
    } finally {
      setOpeningPreview(false);
    }
  }

  useContentEditorAutosave({
    enabled:
      !hasInvalidRichText &&
      persistence.coordinated &&
      persistence.ready &&
      state.status === "dirty" &&
      recoverableEdits.length > 0 &&
      recoveryConflicts.length === 0,
    fingerprint: JSON.stringify(recoverableEdits),
    onSave: startSave,
  });

  function edit(edit: SiteDefinitionEdit): boolean {
    if (
      publicationBusy ||
      saveInFlight.current ||
      !persistence.coordinated ||
      !persistence.ready ||
      contentEditorStatusLocked(state.status)
    ) {
      return false;
    }
    if (updateEditableSiteField(state.workingDefinition, edit) === null) {
      return false;
    }
    persistence.discardAttempt();
    setApprovalId(null);
    setPreviewedRevision(null);
    pendingApprovalAttempt.current = null;
    pendingPublicationAttempt.current = null;
    dispatch({ type: "edit", ...edit });
    return true;
  }

  function moveEditHistory(direction: "undo" | "redo") {
    if (editorLocked) {
      return;
    }
    persistence.discardAttempt();
    setApprovalId(null);
    setPreviewedRevision(null);
    pendingApprovalAttempt.current = null;
    pendingPublicationAttempt.current = null;
    dispatch({ type: direction });
  }

  /**
   * Records the owner's approval of the previewed revision. The approval is
   * bound server-side to a fingerprint of that exact revision; the owner
   * never sees this step — it runs inside the publish flow.
   */
  async function approveRevision(): Promise<string | null> {
    if (hasInvalidRichText) {
      return null;
    }
    pendingApprovalAttempt.current ??= {
      body: JSON.stringify({
        operation: "approve",
        workspaceId: initialRevision.workspaceId,
        revision: state.persistedRevision,
        previewConfirmed: true,
      }),
      idempotencyKey: crypto.randomUUID(),
      revision: state.persistedRevision,
    };
    const attempt = pendingApprovalAttempt.current;
    setPublicationBusy(true);
    setMessage("");
    try {
      const result = await sendContentPublicationAttempt({
        attempt,
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
      if (latestRevisionHead.current !== attempt.revision) {
        // The draft moved on while this approval was in flight, so the
        // approval is bound to a revision that is no longer the latest one.
        // Say so: without a message, Publish looks like a dead button.
        pendingApprovalAttempt.current = null;
        setMessage(
          "The draft changed while this was getting ready. Preview it again, then publish.",
        );
        return null;
      }
      setApprovalId(result.body.approval.id);
      pendingPublicationAttempt.current = null;
      pendingDeploymentRetryAttempt.current = null;
      setPublication((current) =>
        current !== null && publicationIsActive(current) ? current : null,
      );
      pendingApprovalAttempt.current = null;
      return result.body.approval.id;
    } catch {
      setMessage(
        "The draft changed since you looked at the preview. Open the preview again, then publish.",
      );
      return null;
    } finally {
      setPublicationBusy(false);
    }
  }

  async function publishRevision(approval: string) {
    if (hasInvalidRichText) {
      return;
    }
    pendingPublicationAttempt.current ??= {
      body: JSON.stringify({
        operation: "publish",
        workspaceId: initialRevision.workspaceId,
        approvalId: approval,
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
      setPublicationPollAttempt(0);
      setPublication(recorded);
      pendingPublicationAttempt.current = null;
      setMessage(publicationLabels[recorded.status]);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? `Publishing could not be confirmed: ${error.message}. Check the live site before trying again.`
          : "Publishing could not be confirmed. Check the live site before trying again.",
      );
    } finally {
      setPublicationBusy(false);
    }
  }

  /**
   * The one publish action the owner sees. It records the approval of the
   * previewed revision, then starts the publication with it. Both steps keep
   * their own idempotent attempts, so a retry never duplicates either.
   */
  async function approveAndPublish() {
    const approval = approvalId ?? (await approveRevision());
    if (approval === null) {
      return;
    }
    await publishRevision(approval);
  }

  async function retryDeployment() {
    if (publication === null || !contentPublicationCanRetry(publication)) {
      return;
    }
    pendingDeploymentRetryAttempt.current ??= {
      body: JSON.stringify({
        operation: "retry_deployment",
        workspaceId: initialRevision.workspaceId,
        publicationId: publication.id,
      }),
      idempotencyKey: crypto.randomUUID(),
    };
    setPublicationBusy(true);
    setMessage("");
    try {
      const result = await sendContentPublicationAttempt({
        attempt: pendingDeploymentRetryAttempt.current,
        mutationToken,
      });
      pendingDeploymentRetryAttempt.current = null;
      setMutationToken(result.mutationToken);
      if (
        !result.response.ok ||
        typeof result.body !== "object" ||
        result.body === null ||
        !("publication" in result.body) ||
        typeof result.body.publication !== "object" ||
        result.body.publication === null
      ) {
        throw new Error("deployment_retry_failed");
      }
      const recorded = result.body.publication as PublicationRecord;
      setPublicationPollAttempt(0);
      setPublication(recorded);
      setMessage(
        recorded.status === "failed" && recorded.commitSha === null
          ? "Nothing reached the live site, so retrying is safe."
          : recorded.status === "unknown"
            ? "Still checking what happened to this publish."
            : recorded.commitSha !== null
              ? "Your changes were recorded and the live site is being rebuilt."
              : "The retry is recorded.",
      );
    } catch {
      setMessage(
        "The retry did not finish. Try it again — the same request is sent.",
      );
    } finally {
      setPublicationBusy(false);
    }
  }

  async function recoverEdits(destination: "current" | "fresh") {
    if (
      !persistence.coordinated ||
      !persistence.ready ||
      !recoverySourcesReady
    ) {
      return;
    }
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
    const editsToPreserve = mergeStaleRecoveryEdits(
      recoveryPending.current,
      recoverableEdits,
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
      // Stay on the destination the owner is editing from.
      window.location.assign(
        `${window.location.pathname}?${query.toString()}`,
      );
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
    if (!persistence.coordinated || !persistence.ready) {
      return;
    }
    if (resolution === "mine" && conflict.currentValue !== null) {
      if (conflict.path === pageCompositionContract.slot.id) {
        const result = applyStructuralRecovery(
          state.workingDefinition,
          conflict,
        );
        if (result.ok) {
          persistence.discardAttempt();
          dispatch({
            type: "compose",
            definition: result.definition,
            refreshProjection: true,
          });
        } else {
          setMessage(
            "That structural recovery no longer fits the current Site Definition. It remains preserved until you keep the latest structure.",
          );
          return;
        }
      } else {
        if (!edit(conflict)) {
          setMessage(
            "That recovered value no longer fits the current Site Definition. It remains preserved until you keep the latest value.",
          );
          return;
        }
      }
    }
    const remaining = recoveryConflicts.filter(
      (candidate) => candidate.path !== conflict.path,
    );
    recoveryPending.current = recoveryPending.current.filter(
      (candidate) =>
        candidate.path !== conflict.path || resolution === "mine",
    );
    void (recoveryPending.current.length === 0
      ? persistence.clear()
      : persistence.snapshot(recoveryPending.current)
    ).catch(() => {
      setMessage(
        "That choice is active in this tab, but browser recovery storage could not be updated.",
      );
    });
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

  // One toolbar carries the whole draft workflow — undo/redo, save, preview,
  // publish — and stays in reach while the page below is edited. The order
  // left to right follows the order the work happens.
  const publicationNote =
    state.status !== "saved"
      ? ""
      : publication !== null
        ? publicationLabels[publication.status]
        : approvalId !== null || previewedRevision === state.persistedRevision
          ? "Previewed. Ready to publish."
          : "Saved. Preview your draft, then publish it.";

  // The chip answers one question — is my work safe? — in plain words. The
  // revision number stays available to tests and support as data, not copy.
  const statusChipLabels: Record<typeof state.status, string> = {
    saved: "Saved",
    saving: "Saving…",
    dirty: "Unsaved changes",
    conflict: "Out of date",
    stale: "Out of date",
  };
  const statusChip = (
    <span
      className={`state-label state-${state.status}`}
      data-revision={state.persistedRevision}
      title={`Draft revision ${state.persistedRevision}`}
    >
      {statusChipLabels[state.status]}
    </span>
  );

  const historyButtons = (
    <>
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
    </>
  );

  // Publishing is one button. The panel behind it holds the two checks the
  // model requires — everything saved, and the exact draft previewed — in
  // plain words, and the publish action itself. The underlying flow is
  // unchanged: approval of the previewed revision, then publication with it.
  const previewChecked = previewedRevision === state.persistedRevision;
  // A retryable publication is not listed here. The only button that reads
  // this is the "Publish now" arm of the ternary in the publish panel, and
  // that arm renders only when the publication is not retryable — the other
  // arm shows "Retry publish" instead. Listing it would always be false.
  const publishBlocked =
    publicationBusy ||
    hasInvalidRichText ||
    edits.length > 0 ||
    state.status !== "saved" ||
    (!previewChecked && approvalId === null) ||
    (publication !== null && publicationIsActive(publication));
  /*
   * What the first publish step says. Three states look unsaved but cannot
   * save on their own, and each one disables both the Save button and
   * autosave, so none of them may say it is waiting:
   *
   *   conflict            another session's revision landed underneath
   *   recoveryConflicts   edits recovered from this browser clash with the draft
   *   hasInvalidRichText  a body has markup the editor will not store
   *
   * No direction words: the notice sits below the toolbar in both layouts and
   * the publish panel opens downward, so "above" was wrong. The resolve
   * buttons are also not always the same pair — a field the draft no longer
   * has offers only "I've copied this value" — so the text does not name them.
   */
  const saveStepText =
    state.status === "saved"
      ? "All changes are saved."
      : state.status === "conflict"
        ? "Someone else changed this draft. Deal with that notice first, then publish."
        : recoveryConflicts.length > 0
          ? "Recovered edits clash with this draft. Settle each one in the notice, then publish."
          : hasInvalidRichText
            ? "Some text cannot be saved yet. Fix the highlighted body, then publish."
            : "Waiting for your latest change to save…";

  const publishMenu = (
    <details className="publish-menu">
      <summary className="button button-primary">Publish</summary>
      <div className="publish-panel">
        <p className="publish-panel-title">Put this draft on the live site</p>
        <ol className="publish-steps">
          <li data-done={state.status === "saved"}>{saveStepText}</li>
          <li data-done={previewChecked}>
            {previewChecked ? (
              "You have looked at the preview."
            ) : (
              <>
                Look at the preview first — it shows exactly what will go
                live.{" "}
                <button
                  type="button"
                  className="copy-button"
                  disabled={
                    hasInvalidRichText ||
                    openingPreview ||
                    previewUrl === undefined
                  }
                  onClick={() => void openPreview()}
                >
                  {openingPreview
                    ? "Opening…"
                    : hasUnsavedChanges
                      ? "Open the last save ↗"
                      : "Open the preview ↗"}
                </button>
              </>
            )}
          </li>
        </ol>
        {publication !== null && contentPublicationCanRetry(publication) ? (
          <button
            type="button"
            className="button button-primary"
            disabled={publicationBusy}
            onClick={() => void retryDeployment()}
          >
            {publicationBusy ? "Retrying…" : "Retry publish"}
          </button>
        ) : (
          <button
            type="button"
            className="button button-primary"
            disabled={publishBlocked}
            onClick={() => void approveAndPublish()}
          >
            {publicationBusy ? "Publishing…" : "Publish now"}
          </button>
        )}
        {publication === null ? null : (
          <p className="publish-panel-state">
            {publicationLabels[publication.status]}
          </p>
        )}
      </div>
    </details>
  );

  const workflowButtons = (
    <>
      {state.status === "conflict" || state.status === "stale" ? (
        <button
          type="button"
          className="copy-button"
          disabled={
            creatingWorkspace ||
            !persistence.coordinated ||
            !persistence.ready ||
            !recoverySourcesReady
          }
          onClick={() =>
            void recoverEdits(state.status === "stale" ? "fresh" : "current")
          }
        >
          {creatingWorkspace
            ? "Starting…"
            : state.status === "stale"
              ? "Start a fresh draft"
              : "Reload latest"}
        </button>
      ) : null}
      {/* Saving is automatic. The button appears only while there is
        * something unsaved, so a failed autosave always leaves a way to save
        * by hand. */}
      {state.status === "dirty" || state.status === "saving" ? (
        <button
          type="button"
          className="copy-button"
          // editorLocked already covers recoveryConflicts.length > 0.
          disabled={
            (edits.length === 0 && composition === undefined) ||
            hasInvalidRichText ||
            editorLocked
          }
          onClick={startSave}
        >
          {state.status === "saving" ? "Saving…" : "Save"}
        </button>
      ) : null}
      {state.status === "stale" ? null : (
        <button
          type="button"
          className="copy-button"
          // Preview always opens the last save, never the words being typed
          // right now. The label says which, because a title attribute is
          // invisible on a touch screen. The button is not disabled while
          // unsaved: with a recovery conflict, autosave is off and Save is
          // disabled, so disabling this too would leave no way to look at the
          // draft at all.
          title="Opens the last saved draft in a new tab. This is what visitors would see."
          disabled={
            hasInvalidRichText || openingPreview || previewUrl === undefined
          }
          onClick={() => void openPreview()}
        >
          {openingPreview
            ? "Opening preview…"
            : hasUnsavedChanges
              ? "Preview last save ↗"
              : "Preview ↗"}
        </button>
      )}
      {state.status === "stale" ? null : publishMenu}
    </>
  );

  const notesNode =
    publicationNote !== "" || message !== "" || state.status === "stale" ? (
      <div className="editor-notes">
        <p role="status" aria-live="polite" className="editor-message">
          {message}
        </p>
        {state.status === "stale" ? (
          <p className="editor-message">
            This draft was made against an older version of the site. Start a
            fresh workspace to keep editing; these edits stay preserved.
          </p>
        ) : publicationNote !== "" ? (
          <p className="editor-publication-note">{publicationNote}</p>
        ) : null}
      </div>
    ) : null;

  const conflictsNode =
    recoveryConflicts.length > 0 ? (
      <div className="editor-recovery-conflicts" role="alert">
        <p>Resolve these changed field paths manually:</p>
        <ul>
          {recoveryConflicts.map((edit) => (
            <li key={edit.path}>
              <code>{edit.path}</code>
              {edit.reason === "changed" ? (
                <>
                  <span>Latest: {edit.currentValue}</span>
                  <span>Your unsaved value: {displayEditableValue(edit)}</span>
                  <span className="editor-conflict-actions">
                    <button
                      type="button"
                      className="copy-button"
                      disabled={!persistence.coordinated}
                      onClick={() => resolveRecoveryConflict(edit, "latest")}
                    >
                      Keep latest
                    </button>
                    <button
                      type="button"
                      className="copy-button"
                      disabled={!persistence.coordinated}
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
                    {displayEditableValue(edit)}
                  </span>
                  <button
                    type="button"
                    className="copy-button"
                    disabled={!persistence.coordinated}
                    onClick={() => resolveRecoveryConflict(edit, "latest")}
                  >
                    I’ve copied this value
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  const fieldGroupsNode = (
    <EditorFieldGroups
      groups={groups}
      collapsed={false}
      workingFields={workingFields}
      errors={state.errors}
      editorLocked={editorLocked}
      edit={edit}
      updateRichTextValidation={updateRichTextValidation}
    />
  );

  const historyPanelNode = showPublicationHistory ? (
    <details className="publication-history-panel">
      <summary>Publishing history</summary>
      <PublicationHistory
        mutationToken={mutationToken}
        onMutationToken={setMutationToken}
        onMessage={setMessage}
        refreshKey={contentPublicationHistoryRefreshKey(publication)}
      />
    </details>
  ) : null;
  const activeWorkspaceQuery = activeWorkspaceUrl.includes("?")
    ? activeWorkspaceUrl.slice(activeWorkspaceUrl.indexOf("?"))
    : "";

  if (!showComposition) {
    // Design and any other canvas-less destination: a toolbar and the fields.
    return (
      <section className="content-editor" aria-label={heading}>
        <div className="editor-toolbar" role="group" aria-label="Draft controls">
          {statusChip}
          <span className="editor-toolbar-actions">
            {historyButtons}
            {workflowButtons}
          </span>
        </div>
        {notesNode}
        {conflictsNode}
        {fieldGroupsNode}
        {historyPanelNode}
      </section>
    );
  }

  // Pages: the editor takes the whole window, the way a visual CMS does. One
  // slim bar carries the workflow; below it the site fills the screen. Browse
  // mode is the site as itself — no highlights, no chrome in the page — and
  // Edit mode brings the canvas, the selection panel, and in-place text.
  return (
    <section className="content-editor editor-immersive" aria-label={heading}>
      <header className="editor-topbar">
        <a className="topbar-back" href={`/dash${activeWorkspaceQuery}`}>
          ← Dashboard
        </a>
        <h1 className="topbar-title">{heading}</h1>
        <div className="mode-toggle" role="group" aria-label="Editor mode">
          <button
            type="button"
            aria-pressed={editorMode === "browse"}
            onClick={() => setEditorMode("browse")}
          >
            Browse
          </button>
          <button
            type="button"
            aria-pressed={editorMode === "edit"}
            onClick={() => setEditorMode("edit")}
          >
            Edit
          </button>
        </div>
        <div className="topbar-grow" />
        {statusChip}
        <div className="editor-toolbar-actions">
          {historyButtons}
          {workflowButtons}
        </div>
      </header>
      {/* Always rendered at a stable height: the note's text changes with
        * the autosave cycle, and mounting it in and out made the canvas jump
        * on every edit. */}
      <div className="editor-notes editor-notes-immersive">
        <p role="status" aria-live="polite" className="editor-message">
          {message}
        </p>
        {state.status === "stale" ? (
          <p className="editor-message">
            This draft was made against an older version of the site. Start a
            fresh workspace to keep editing; these edits stay preserved.
          </p>
        ) : (
          <p className="editor-publication-note">{publicationNote}</p>
        )}
      </div>
      {conflictsNode}
      {editorMode === "browse" ? (
        <div
          className="editor-browse"
          onClickCapture={(event) => blockBrowseNavigation(event)}
          onAuxClickCapture={(event) => blockBrowseNavigation(event)}
        >
          <SiteRenderer definition={state.workingDefinition} editingSurface />
        </div>
      ) : (
        <div className="editor-stage">
          <VisualComponentEditor
            // Keyed by projection only: the canvas rebuilds when the
            // definition is changed from outside it (undo, redo, field edits,
            // recovery). Saves advance persistedRevision without touching
            // what the canvas shows, so a save — including the automatic
            // ones — must not remount the editor and destroy the owner's
            // selection mid-edit.
            key={`projection:${state.projectionVersion}`}
            definition={state.workingDefinition}
            disabled={editorLocked}
            onValidationChange={updateVisualRichTextValidation}
            panelWhenEmpty={
              <>
                {fieldGroupsNode}
                {historyPanelNode}
              </>
            }
            onChange={(definition) => {
              if (
                publicationBusy ||
                saveInFlight.current ||
                contentEditorStatusLocked(state.status)
              ) {
                return;
              }
              persistence.discardAttempt();
              setApprovalId(null);
              setPreviewedRevision(null);
              pendingApprovalAttempt.current = null;
              pendingPublicationAttempt.current = null;
              dispatch({ type: "compose", definition });
            }}
          />
        </div>
      )}
    </section>
  );
}

function EditorFieldGroups({
  groups,
  collapsed,
  workingFields,
  errors,
  editorLocked,
  edit,
  updateRichTextValidation,
}: {
  groups: ReadonlyArray<EditableFieldGroup>;
  collapsed: boolean;
  workingFields: ReadonlyArray<EditableSiteField>;
  errors: Readonly<Record<string, string>>;
  editorLocked: boolean;
  edit(edit: SiteDefinitionEdit): void;
  updateRichTextValidation(source: string, invalid: boolean): void;
}) {
  const fieldGroups = (
      <div className="editor-groups">
        {groups.map((group) => (
          <fieldset key={group}>
            {/* One group under its own heading needs no second label. */}
            {groups.length > 1 ? <legend>{group}</legend> : null}
            {workingFields
              .filter((field) => field.group === group)
              .map((field) => {
                const labelId = `${field.path}-label`;
                // The schema path stays on the element as data-field-path for
                // debugging and tests. It is not shown, because a site owner
                // reads "SEO title", not "page.home.seo.title".
                const fieldLabel = (
                  <span id={labelId}>{field.label}</span>
                );
                // An optional field needs to say what happens when it is left
                // blank, or the owner cannot tell "empty" from "broken".
                const fieldHint =
                  field.hint === undefined ? null : (
                    <small
                      className="editor-field-hint"
                      id={`${field.path}-hint`}
                    >
                      {field.hint}
                    </small>
                  );
                // A hint a screen reader never reaches is not a hint. Name it
                // ahead of the error so the control reads out what the field
                // is for before what is wrong with it.
                const fieldDescribedBy =
                  field.hint === undefined
                    ? `${field.path}-error`
                    : `${field.path}-hint ${field.path}-error`;
                const fieldError = (
                  <small id={`${field.path}-error`}>
                    {errors[field.path] ?? ""}
                  </small>
                );
                if (field.format === "richText") {
                  return (
                    <div
                      className="editor-field"
                      key={field.path}
                      data-field-path={field.path}
                      role="group"
                      aria-labelledby={labelId}
                    >
                      {fieldLabel}
                      {fieldHint}
                      <RichTextEditor
                        id={`${field.path}-editor`}
                        disabled={editorLocked}
                        value={field.value}
                        invalid={Boolean(errors[field.path])}
                        describedBy={fieldDescribedBy}
                        labelledBy={labelId}
                        onChange={(value) =>
                          edit({
                            path: field.path,
                            format: "richText",
                            value,
                          })
                        }
                        onValidationChange={(invalid) =>
                          updateRichTextValidation(field.path, invalid)
                        }
                      />
                      {fieldError}
                    </div>
                  );
                }
                return (
                  <label key={field.path} data-field-path={field.path}>
                    {fieldLabel}
                    {fieldHint}
                    {field.values !== undefined ? (
                      <select
                        disabled={editorLocked}
                        value={field.value}
                        aria-invalid={Boolean(errors[field.path])}
                        aria-describedby={fieldDescribedBy}
                        onChange={(event) =>
                          edit({
                            path: field.path,
                            format: "plainText",
                            value: event.target.value,
                          })
                        }
                      >
                        {field.values.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    ) : field.multiline ? (
                      <textarea
                        rows={3}
                        disabled={editorLocked}
                        value={field.value}
                        aria-invalid={Boolean(errors[field.path])}
                        aria-describedby={fieldDescribedBy}
                        onChange={(event) =>
                          edit({
                            path: field.path,
                            format: "plainText",
                            value: event.target.value,
                          })
                        }
                      />
                    ) : (
                      <input
                        disabled={editorLocked}
                        value={field.value}
                        aria-invalid={Boolean(errors[field.path])}
                        aria-describedby={fieldDescribedBy}
                        onChange={(event) =>
                          edit({
                            path: field.path,
                            format: "plainText",
                            value: event.target.value,
                          })
                        }
                      />
                    )}
                    {fieldError}
                  </label>
                );
              })}
          </fieldset>
        ))}
      </div>
  );
  if (!collapsed) {
    return fieldGroups;
  }
  return (
    <details className="page-settings">
      <summary>Page details — name, navigation, footer and SEO</summary>
      {fieldGroups}
    </details>
  );
}

function displayEditableValue(edit: SiteDefinitionEdit): string {
  return edit.format === "richText" ? "Rich-text content" : edit.value;
}
