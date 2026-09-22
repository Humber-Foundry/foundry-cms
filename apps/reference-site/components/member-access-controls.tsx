"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";

import type {
  HumanMembership,
  HumanRole,
  MembershipStatus,
} from "@humber-foundry/application";
import {
  availableMembershipStatusActions,
  otherHumanRole,
} from "@humber-foundry/application";
import {
  membershipStatusDisplayLabel,
  roleDisplayLabel,
} from "./access-display";
import {
  createHumanAccessMutationAttempt,
  humanAccessMutationFailureMessage,
  isHumanAccessMutationAmbiguousFailure,
  isHumanAccessMutationInProgress,
  isHumanAccessMutationRequestCheckFailed,
  isHumanAccessMutationRequestCheckUnavailable,
  membershipStatusConfirmation,
  roleChangeConfirmation,
  sendHumanAccessMutationAttempt,
  type HumanAccessMutationAttempt,
} from "../src/human-access-mutation-client";

const statusActionLabels: Readonly<Record<MembershipStatus, string>> = {
  active: "Activate",
  suspended: "Suspend",
  revoked: "Revoke",
};

/**
 * What a person holding each role can and cannot do, drawn from the
 * capability table in `@humber-foundry/application` (`roleCapabilities` in
 * `human-access.ts`), not invented for this screen.
 *
 * One short sentence each, because these are read inside a table row rather
 * than in a legend above it (#240).
 */
const roleMeaning: Readonly<Record<HumanRole, string>> = {
  owner:
    "Can change everything, including users, connections and sending email to the list.",
  editor:
    "Can write and publish pages and posts, and read messages. Cannot change users or connections.",
};

/**
 * What each access state means for a user, matching the wording already
 * used in the status-change confirmations above.
 */
const statusMeaning: Readonly<Record<MembershipStatus, string>> = {
  active: "Can sign in now.",
  suspended: "Cannot sign in. You can activate them again.",
  revoked: "Access is removed for good. They need a new invitation to return.",
};

/**
 * One request in flight against `/api/foundry-cms/members`: an invite, a
 * status change or a role change. Everything a screen needs to show its
 * result and to retry it safely lives here, so the invite form, the user
 * table and the technical retry controls in Settings can all show the same
 * state without duplicating the request logic.
 */
export type HumanAccessMutation = Readonly<{
  message: string;
  pending: boolean;
  retryAvailable: boolean;
  syncPending: boolean;
  send(command?: unknown): Promise<boolean>;
  retry(): void;
  reconcileAccess(): void;
}>;

export function useHumanAccessMutation({
  csrfToken,
}: {
  csrfToken: string;
}): HumanAccessMutation {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [retryAvailable, setRetryAvailable] = useState(false);
  const [syncPending, setSyncPending] = useState(false);
  const mutationAttempt = useRef<HumanAccessMutationAttempt | null>(null);

  async function send(command?: unknown): Promise<boolean> {
    setPending(true);
    setMessage("");
    try {
      if (mutationAttempt.current === null) {
        mutationAttempt.current = createHumanAccessMutationAttempt(command);
      }

      let response: Response;
      try {
        response = await sendHumanAccessMutationAttempt(
          mutationAttempt.current,
          csrfToken,
        );
      } catch {
        setRetryAvailable(true);
        setMessage(
          "The result could not be confirmed. Retry the same access change.",
        );
        return false;
      }

      if (await isHumanAccessMutationInProgress(response)) {
        setRetryAvailable(true);
        setMessage(
          "The access change is still processing. Retry to check the same request.",
        );
        return false;
      }

      if (await isHumanAccessMutationRequestCheckFailed(response)) {
        setRetryAvailable(true);
        setMessage(
          "The access check expired or changed. Refreshing… Retry the same access change.",
        );
        router.refresh();
        return false;
      }
      if (await isHumanAccessMutationRequestCheckUnavailable(response)) {
        setRetryAvailable(true);
        setMessage(
          "The access check is temporarily unavailable. Retry the same access change.",
        );
        return false;
      }
      if (await isHumanAccessMutationAmbiguousFailure(response)) {
        setRetryAvailable(true);
        setMessage(
          "The result could not be confirmed. Retry the same access change.",
        );
        return false;
      }
      mutationAttempt.current = null;
      setRetryAvailable(false);
      if (!response.ok) {
        const body: unknown = await response.json();
        if (
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          body.error === "access_sync_pending"
        ) {
          setSyncPending(true);
          setMessage(
            "The D1 change is active. Cloudflare policy sync is pending.",
          );
          router.refresh();
          return true;
        }
        setMessage(humanAccessMutationFailureMessage(body));
        return true;
      }
      setSyncPending(false);
      setMessage("Access updated.");
      router.refresh();
      return true;
    } finally {
      setPending(false);
    }
  }

  return {
    message,
    pending,
    retryAvailable,
    syncPending,
    send,
    retry: () => {
      void send();
    },
    reconcileAccess: () => {
      void send({ action: "reconcile_access" });
    },
  };
}

/**
 * The retry actions for a human access mutation whose result could not be
 * confirmed, or whose Cloudflare policy sync is still pending.
 *
 * These only appear after a change on this same screen did not confirm, and
 * retrying means replaying that exact request. They therefore stay on the
 * Users tab, under the table, with the mutation they belong to. The Site tab
 * carries the separate "copy access to Cloudflare again" action, which is its
 * own command and needs no earlier request (#240).
 */
export function AccessSyncRetryControls({
  mutation,
}: {
  mutation: HumanAccessMutation;
}) {
  if (!mutation.retryAvailable && !mutation.syncPending) {
    return null;
  }
  return (
    <p className="access-sync-retry-controls">
      {mutation.retryAvailable ? (
        <button
          className="copy-button"
          type="button"
          disabled={mutation.pending}
          onClick={mutation.retry}
        >
          Retry access change
        </button>
      ) : null}
      {mutation.syncPending ? (
        <button
          className="copy-button"
          type="button"
          disabled={mutation.pending || mutation.retryAvailable}
          onClick={mutation.reconcileAccess}
        >
          Retry Cloudflare sync
        </button>
      ) : null}
    </p>
  );
}

/**
 * "Copy access to Cloudflare again" on Settings' Site tab.
 *
 * Every access change is written here first and then copied to Cloudflare. A
 * copy can fall behind, and this runs it again. It is its own command rather
 * than a replay of an earlier request, so it owns its own mutation state and
 * can sit on a different screen from the user table (#240).
 */
export function AccessSyncReconcileControls({
  csrfToken,
}: {
  csrfToken: string;
}) {
  const mutation = useHumanAccessMutation({ csrfToken });
  return (
    <>
      <p>
        Who may sign in is kept here and copied to Cloudflare, which is what
        actually lets a person through. If someone you invited still cannot
        sign in, run the copy again.
      </p>
      <p className="panel-actions">
        <button
          className="copy-button"
          type="button"
          disabled={mutation.pending}
          onClick={mutation.reconcileAccess}
        >
          Copy access to Cloudflare again
        </button>
      </p>
      <p role="status" aria-live="polite">
        {mutation.message}
      </p>
    </>
  );
}

type PendingMemberAction =
  | Readonly<{ kind: "status"; member: HumanMembership; status: MembershipStatus }>
  | Readonly<{ kind: "role"; member: HumanMembership; role: HumanRole }>;

/**
 * Asks before a status or role change takes effect. A native <dialog> gives
 * it its own modal backdrop, focus handling and Escape key, matching the
 * pattern the revoke dialog in `mcp-connection-controls.tsx` uses, so this
 * screen never falls back to the browser's own `window.confirm`.
 */
function MemberActionConfirmDialog({
  pendingAction,
  confirmation,
  onConfirm,
  onCancel,
}: {
  pendingAction: PendingMemberAction | null;
  confirmation: string | null;
  onConfirm(): void;
  onCancel(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (confirmation !== null && !element.open) element.showModal();
    if (confirmation === null && element.open) element.close();
  }, [confirmation]);

  return (
    <dialog
      className="revoke-confirm-dialog"
      ref={dialog}
      aria-labelledby="member-action-confirm-title"
      onClose={onCancel}
      onCancel={onCancel}
    >
      {pendingAction === null || confirmation === null ? null : (
        <>
          <h2 id="member-action-confirm-title">
            {pendingAction.kind === "role"
              ? "Change this person's role?"
              : "Change this person's access?"}
          </h2>
          <p>{confirmation}</p>
          <div className="revoke-confirm-actions">
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" onClick={onConfirm}>
              Confirm
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}

/**
 * The user table, then the invite form, then the role and access actions on
 * each row.
 *
 * The table comes first because it answers the question an Owner opens this
 * screen with: who can sign in today. Inviting someone is the rarer job, so it
 * sits under the answer (#240).
 *
 * What "Owner", "Editor", "Active", "Suspended" and "Revoked" mean is written
 * into the rows themselves, in plain sentences. There used to be a legend of
 * five help tips above the table; the owner read it as a row of question marks
 * that explained the table he could not yet see.
 *
 * The technical retry action for a mutation that could not be confirmed lives
 * in `AccessSyncRetryControls` instead — see `useHumanAccessMutation`'s doc
 * comment for why the two are split.
 */
export function MemberAccessPanel({
  members,
  mutation,
}: {
  members: ReadonlyArray<HumanMembership>;
  mutation: HumanAccessMutation;
}) {
  const [pendingAction, setPendingAction] =
    useState<PendingMemberAction | null>(null);

  // The server always refuses a role, suspend or revoke change that would
  // leave the site with no active Owner (the `human_memberships_preserve_
  // last_owner` D1 trigger, ADR-0027). The list the server already returned
  // is the same list the trigger checks, so counting active Owners here
  // tells the row which actions would only ever fail.
  const activeOwnerCount = members.filter(
    (candidate) => candidate.role === "owner" && candidate.status === "active",
  ).length;

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const completed = await mutation.send({
      action: "invite",
      email: data.get("email"),
      role: data.get("role"),
    });
    if (completed) {
      form.reset();
    }
  }

  function requestStatusChange(
    member: HumanMembership,
    status: MembershipStatus,
  ) {
    const confirmation = membershipStatusConfirmation(member.email, status);
    if (confirmation === null) {
      void mutation.send({
        action: "change_status",
        membershipId: member.id,
        status,
      });
      return;
    }
    setPendingAction({ kind: "status", member, status });
  }

  function requestRoleChange(member: HumanMembership, role: HumanRole) {
    setPendingAction({ kind: "role", member, role });
  }

  function confirmPendingAction() {
    if (pendingAction === null) return;
    if (pendingAction.kind === "status") {
      void mutation.send({
        action: "change_status",
        membershipId: pendingAction.member.id,
        status: pendingAction.status,
      });
    } else {
      void mutation.send({
        action: "change_role",
        membershipId: pendingAction.member.id,
        role: pendingAction.role,
      });
    }
    setPendingAction(null);
  }

  const confirmation: string | null =
    pendingAction === null
      ? null
      : pendingAction.kind === "status"
        ? membershipStatusConfirmation(
            pendingAction.member.email,
            pendingAction.status,
          )
        : roleChangeConfirmation(pendingAction.member.email, pendingAction.role);

  return (
    <>
      <div
        className="inventory-table member-access-table"
        role="table"
        aria-label="Users"
      >
        <div className="inventory-row inventory-head" role="row">
          <span role="columnheader">User</span>
          <span role="columnheader">Access</span>
          <span role="columnheader">Actions</span>
        </div>
        {members.map((member) => {
          // The only active Owner cannot be made an Editor, suspended or
          // revoked — every one of those would leave the site with no
          // active Owner, and the server always refuses it. Offering the
          // buttons here would only ever produce a failed request, so this
          // row explains the rule instead (#150).
          const isSoleActiveOwner =
            member.role === "owner" &&
            member.status === "active" &&
            activeOwnerCount <= 1;

          return (
            <div className="inventory-row" role="row" key={member.id}>
              <strong role="cell">
                {member.email}
                <small>
                  {roleDisplayLabel[member.role]}. {roleMeaning[member.role]}
                </small>
              </strong>
              <span role="cell" className="member-access-state">
                <span className="state-label">
                  {membershipStatusDisplayLabel[member.status]}
                </span>
                <small>{statusMeaning[member.status]}</small>
              </span>
              <div role="cell" className="member-actions">
                {isSoleActiveOwner ? (
                  <span className="member-actions-note">
                    The site must always have one Owner, so make another
                    person an Owner first.
                  </span>
                ) : (
                  <>
                    {member.status === "revoked" ? null : (
                      <button
                        type="button"
                        disabled={mutation.pending || mutation.retryAvailable}
                        onClick={() =>
                          requestRoleChange(member, otherHumanRole(member.role))
                        }
                      >
                        Make {roleDisplayLabel[otherHumanRole(member.role)]}
                      </button>
                    )}
                    {availableMembershipStatusActions(member.status).map(
                      (status) => (
                        <button
                          key={status}
                          type="button"
                          disabled={mutation.pending || mutation.retryAvailable}
                          onClick={() => requestStatusChange(member, status)}
                        >
                          {statusActionLabels[status]}
                        </button>
                      ),
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <h3 className="access-invite-heading">Invite someone</h3>
      <form onSubmit={invite} className="access-invite-form">
        <label>
          Email
          <input name="email" type="email" required />
        </label>
        <label>
          Role
          <select name="role" defaultValue="editor">
            <option value="editor">Editor</option>
            <option value="owner">Owner</option>
          </select>
        </label>
        <button
          className="copy-button"
          type="submit"
          disabled={mutation.pending || mutation.retryAvailable}
        >
          Invite user
        </button>
      </form>
      <p role="status" aria-live="polite">
        {mutation.message}
      </p>
      <MemberActionConfirmDialog
        pendingAction={pendingAction}
        confirmation={confirmation}
        onConfirm={confirmPendingAction}
        onCancel={() => setPendingAction(null)}
      />
    </>
  );
}

