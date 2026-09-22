"use client";

import { useEffect, useRef, useState } from "react";

import {
  sendContentRevisionAttempt,
  type ContentRevisionAttempt,
} from "@/src/content-revision-client";
import {
  editorPageHref,
  editorPagePublishedStateLabels,
  editorPagePublishedStateTones,
} from "@/src/editor-page-selection";
import type { PageActionSummary } from "@/src/page-lifecycle-view";
import {
  DashboardActionMenu,
  type DashboardAction,
} from "./dashboard-action-menu";
import { DashboardList, DashboardListRow } from "./dashboard-list";
import { DashboardStateLabel } from "./dashboard-state-label";

/** Which dialog is open, and the page it is about. */
type OpenDialog = Readonly<{
  kind: "rename" | "duplicate" | "delete";
  page: PageActionSummary;
}>;

type FormState = Readonly<{
  title: string;
  slug: string;
}>;

const emptyForm: FormState = { title: "", slug: "" };

const dialogTitles: Readonly<Record<OpenDialog["kind"], string>> = {
  rename: "Rename this page",
  duplicate: "Duplicate this page",
  delete: "Delete this page?",
};

const submitLabels: Readonly<Record<OpenDialog["kind"], string>> = {
  rename: "Save changes",
  duplicate: "Duplicate page",
  delete: "Delete page",
};

/**
 * The boxes each dialog draws, so a refusal that names one of them is shown
 * beside that box instead of as a sentence over the whole dialog.
 *
 * The delete dialog draws no box at all, so every refusal it gets is a loose
 * one and reads as a sentence.
 */
const dialogFields: Readonly<
  Record<OpenDialog["kind"], ReadonlyArray<string>>
> = {
  rename: ["title", "slug"],
  duplicate: ["title", "slug"],
  delete: [],
};

/**
 * Every page of the draft, with the controls that rename, duplicate and
 * delete one.
 *
 * Pages are added by a connected agent through MCP `foundry.page.create`, not
 * from this screen. See ADR-0041.
 *
 * Each control sends one page operation to the revisions route, which runs the
 * application operation. Nothing here decides whether an operation is allowed:
 * it shows what the draft says, and it shows back whatever the application
 * refuses. A delete is confirmed in a dialog of this dashboard's own, never by
 * the browser's own confirmation box.
 */
export function PageLifecycleList({
  pages,
  workspaceId,
  schemaVersion,
  baseRevision,
  csrfToken,
  workspaceUrl,
}: {
  pages: ReadonlyArray<PageActionSummary>;
  workspaceId: string;
  schemaVersion: string;
  baseRevision: number;
  csrfToken: string;
  workspaceUrl: string;
}) {
  const [open, setOpen] = useState<OpenDialog | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>(
    {},
  );
  const [mutationToken, setMutationToken] = useState(csrfToken);
  const pendingAttempt = useRef<ContentRevisionAttempt | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open !== null && !element.open) element.showModal();
    if (open === null && element.open) element.close();
  }, [open]);

  function start(next: OpenDialog) {
    pendingAttempt.current = null;
    setMessage(null);
    setFieldErrors({});
    setBusy(false);
    setForm(
      next.kind === "duplicate"
        ? { title: next.page.duplicateTitle, slug: next.page.duplicateSlug }
        : { title: next.page.title, slug: next.page.slug },
    );
    setOpen(next);
  }

  /**
   * Shut the dialog, unless a change is on its way.
   *
   * Escape and the backdrop both reach here through the dialog's own cancel
   * event. That event has to be stopped while busy, or the browser closes the
   * dialog while this component still believes it is open, and whatever the
   * server says next is never shown.
   */
  function close(event?: { preventDefault(): void }) {
    if (busy) {
      event?.preventDefault();
      return;
    }
    setOpen(null);
  }

  function bodyFor(current: OpenDialog): string {
    const common = { workspaceId, schemaVersion, baseRevision };
    if (current.kind === "delete") {
      return JSON.stringify({
        operation: "delete_page",
        ...common,
        pageId: current.page.id,
      });
    }
    return JSON.stringify({
      operation: current.kind === "rename" ? "rename_page" : "duplicate_page",
      ...common,
      pageId: current.page.id,
      title: form.title,
      slug: form.slug,
    });
  }

  async function submit(current: OpenDialog) {
    setBusy(true);
    setMessage(null);
    setFieldErrors({});
    // A retry after an unknown result resends the same key and the same body,
    // so it can never make a second page.
    const attempt: ContentRevisionAttempt = pendingAttempt.current ?? {
      body: bodyFor(current),
      idempotencyKey: `${current.kind}_page:${crypto.randomUUID()}`,
    };
    pendingAttempt.current = attempt;
    try {
      const result = await sendContentRevisionAttempt({
        attempt,
        mutationToken,
      });
      setMutationToken(result.mutationToken);
      const body = result.body as Record<string, unknown> | null;
      if (result.response.status === 201) {
        pendingAttempt.current = null;
        const createdPageId =
          typeof body?.pageId === "string" ? body.pageId : undefined;
        // A copy opens in the editor straight away. A rename or a delete
        // comes back to the list, which then shows what changed.
        window.location.assign(
          current.kind === "duplicate" && createdPageId !== undefined
            ? editorPageHref(workspaceUrl, createdPageId)
            : workspaceUrl,
        );
        return;
      }
      if (
        result.response.status === 422 &&
        typeof body?.fields === "object" &&
        body.fields !== null
      ) {
        pendingAttempt.current = null;
        const fields = body.fields as Record<string, string>;
        setFieldErrors(fields);
        // A refusal that names a box this dialog draws is shown beside that
        // box, and the dialog says nothing over the top of it. A refusal that
        // names anything else has no box to sit beside, so its own sentence —
        // which names what was wrong — is shown instead. An empty list names
        // nothing at all, so the dialog falls back to the general sentence.
        const drawn = dialogFields[current.kind];
        const loose = Object.entries(fields).filter(
          ([key]) => !drawn.includes(key),
        );
        setMessage(
          loose.length > 0
            ? loose.map(([, sentence]) => sentence).join(" ")
            : Object.keys(fields).length > 0
              ? null
              : refusalSentence(result.response.status, body),
        );
        setBusy(false);
        return;
      }
      pendingAttempt.current = null;
      setMessage(refusalSentence(result.response.status, body));
      setBusy(false);
    } catch {
      setMessage(
        "The result is not yet known. Trying again sends the exact same change, so nothing is duplicated.",
      );
      setBusy(false);
    }
  }

  const current = open;
  const showsNameAndAddress =
    current !== null && current.kind !== "delete";
  const slugChangeWarning =
    current !== null &&
    current.kind === "rename" &&
    current.page.isPublished &&
    form.slug !== current.page.slug;

  return (
    <>
      <DashboardList label="Your pages">
        {pages.map((page) => (
          <DashboardListRow
            key={page.id}
            href={editorPageHref(workspaceUrl, page.id)}
            title={page.title}
            note={`Address: ${page.path}`}
            state={
              <DashboardStateLabel
                tone={editorPagePublishedStateTones[page.publishedState]}
              >
                {editorPagePublishedStateLabels[page.publishedState]}
              </DashboardStateLabel>
            }
            actions={
              <DashboardActionMenu
                label={`Actions for ${page.title}`}
                actions={rowActions(page, start)}
              />
            }
          />
        ))}
      </DashboardList>

      <dialog
        className="page-lifecycle-dialog"
        ref={dialog}
        aria-labelledby="page-lifecycle-title"
        onClose={close}
        onCancel={close}
      >
        {current === null ? null : (
          <form
            method="dialog"
            onSubmit={(event) => {
              event.preventDefault();
              void submit(current);
            }}
          >
            <h2 id="page-lifecycle-title">{dialogTitles[current.kind]}</h2>
            {current.kind === "delete" ? (
              <DeleteExplanation page={current.page} />
            ) : null}
            {showsNameAndAddress ? (
              <>
                <p className="page-lifecycle-field">
                  <label htmlFor="page-lifecycle-name">Page name</label>
                  <input
                    id="page-lifecycle-name"
                    name="title"
                    type="text"
                    value={form.title}
                    autoComplete="off"
                    aria-invalid={fieldErrors.title !== undefined}
                    aria-describedby={
                      fieldErrors.title === undefined
                        ? undefined
                        : "page-lifecycle-name-error"
                    }
                    onChange={(event) =>
                      setForm((state) => ({
                        ...state,
                        title: event.target.value,
                      }))
                    }
                  />
                  {fieldErrors.title === undefined ? null : (
                    <span id="page-lifecycle-name-error" role="alert">
                      {fieldErrors.title}
                    </span>
                  )}
                </p>
                <p className="page-lifecycle-field">
                  <label htmlFor="page-lifecycle-address">Web address</label>
                  <input
                    id="page-lifecycle-address"
                    name="slug"
                    type="text"
                    value={form.slug}
                    autoComplete="off"
                    aria-invalid={fieldErrors.slug !== undefined}
                    aria-describedby={
                      fieldErrors.slug === undefined
                        ? "page-lifecycle-address-hint"
                        : "page-lifecycle-address-error"
                    }
                    onChange={(event) =>
                      setForm((state) => ({
                        ...state,
                        slug: event.target.value,
                      }))
                    }
                  />
                  <span id="page-lifecycle-address-hint">
                    Visitors reach this page at /{form.slug}
                  </span>
                  {fieldErrors.slug === undefined ? null : (
                    <span id="page-lifecycle-address-error" role="alert">
                      {fieldErrors.slug}
                    </span>
                  )}
                </p>
              </>
            ) : null}
            {slugChangeWarning ? (
              <p className="page-lifecycle-warning" role="status">
                This page is on your site at {current.page.path}. When you
                publish this change, that old address stops working and
                visitors who saved it will not find the page.
              </p>
            ) : null}
            {message === null ? null : (
              <p className="page-lifecycle-message" role="alert">
                {message}
              </p>
            )}
            <div className="page-lifecycle-buttons">
              <button type="button" onClick={close} disabled={busy}>
                Cancel
              </button>
              <button
                type="submit"
                disabled={
                  busy ||
                  (current.kind === "delete" && !current.page.canDelete)
                }
              >
                {busy ? "Working…" : submitLabels[current.kind]}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </>
  );
}

/**
 * The actions one page's menu holds.
 *
 * The home page's menu holds no Delete. Every site needs a home page, so a
 * delete could never succeed, and a control the owner cannot press is worse
 * than no control at all. Delete sits last and is drawn in the warning
 * colour, because it removes something.
 */
function rowActions(
  page: PageActionSummary,
  start: (next: OpenDialog) => void,
): ReadonlyArray<DashboardAction> {
  const actions: DashboardAction[] = [
    {
      id: "rename",
      label: "Rename",
      onSelect: () => start({ kind: "rename", page }),
    },
    {
      id: "duplicate",
      label: "Duplicate",
      onSelect: () => start({ kind: "duplicate", page }),
    },
  ];
  if (!page.isHome) {
    actions.push({
      id: "delete",
      label: "Delete",
      tone: "destructive",
      onSelect: () => start({ kind: "delete", page }),
    });
  }
  return actions;
}

/** What a delete does, or what must change before it can happen. */
function DeleteExplanation({ page }: { page: PageActionSummary }) {
  // The home page has no Delete in its menu, so this dialog never opens for
  // it and needs no sentence about it.
  if (page.blockedBy.length > 0) {
    return (
      <>
        <p>
          {page.title} is still linked from {page.blockedBy.length === 1
            ? "one place"
            : `${page.blockedBy.length} places`}
          . Change {page.blockedBy.length === 1 ? "that link" : "those links"}{" "}
          first, then delete the page.
        </p>
        <ul className="page-lifecycle-blockers">
          {page.blockedBy.map((blocker) => (
            <li key={`${blocker.name}${blocker.href}`}>
              <a href={blocker.href}>{blocker.name}</a>
            </li>
          ))}
        </ul>
      </>
    );
  }
  return (
    <p>
      {page.title} at {page.path} will be taken out of this draft.{" "}
      {page.isPublished
        ? "It stays on your live site until you publish this change, and an earlier version can still be restored."
        : "It was never published, so nothing on your live site changes."}
    </p>
  );
}

/** One sentence for a refusal that names no single box. */
function refusalSentence(
  status: number,
  body: Record<string, unknown> | null,
): string {
  const reason = typeof body?.error === "string" ? body.error : "";
  if (status === 409 && reason === "revision_conflict") {
    return "This draft changed somewhere else — maybe in another tab. Reload this page before trying again.";
  }
  if (status === 409 && reason === "revision_stale") {
    return "This draft is behind your live site. Reload this page to start from the latest.";
  }
  if (status === 409) {
    return "That change was already sent with different details. Reload this page and try again.";
  }
  if (status === 403) {
    return "We could not check that request. Reload this page and try again.";
  }
  return "That did not work. Reload this page and try again.";
}
