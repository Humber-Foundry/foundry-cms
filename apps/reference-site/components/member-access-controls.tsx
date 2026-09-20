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
import { HelpTip } from "./help-tip";
import {
  membershipStatusDisplayLabel,
  roleDisplayLabel,
} from "./access-display";
import {
  createHumanAccessMutationAttempt,
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
 */
const roleMeaning: Readonly<Record<HumanRole, string>> = {
  owner:
    "Owners can do everything an Editor can, plus manage users, connections, subscriber details and approve bulk sending.",
  editor:
    "Editors can edit and publish site and blog content, prepare campaigns and review messages. They cannot manage users, connections or subscriber details, or send bulk email.",
};

/**
 * What each access state means for a user, matching the wording already
 * used in the status-change confirmations above.
 */
const statusMeaning: Readonly<Record<MembershipStatus, string>> = {
  active: "This person can sign in and use the dashboard with their role.",
  suspended:
    "This person cannot sign in. An Owner can activate them again.",
  revoked:
    "This person's access is permanently removed. They need a new invitation to return.",
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
        setMessage("Access change was not applied.");
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
 * confirmed, or whose Cloudflare policy sync is still pending. These are
 * operator recovery actions rather than something an Owner needs on an
 * ordinary visit, so Settings tucks them inside the "Technical detail"
 * disclosure rather than showing them next to the user table.
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
 * "Owner", "Editor", "Active", "Suspended" and "Revoked" all appear on this
 * screen as plain words. Each one gets a `HelpTip` explaining what it means
 * for the person holding it, so the table can stay short words instead of
 * full sentences.
 */
function RoleAndStatusHelp() {
  return (
    <p className="access-legend">
      <span>
        Owner{" "}
        <HelpTip label="What can an Owner do?">{roleMeaning.owner}</HelpTip>
      </span>
      <span>
        Editor{" "}
        <HelpTip label="What can an Editor do?">{roleMeaning.editor}</HelpTip>
      </span>
      <span>
        Active{" "}
        <HelpTip label="What does Active mean?">
          {statusMeaning.active}
        </HelpTip>
      </span>
      <span>
        Suspended{" "}
        <HelpTip label="What does Suspended mean?">
          {statusMeaning.suspended}
        </HelpTip>
      </span>
      <span>
        Revoked{" "}
        <HelpTip label="What does Revoked mean?">
          {statusMeaning.revoked}
        </HelpTip>
      </span>
    </p>
  );
}

/**
 * Invites, the user table, and the role and access actions on it. The
 * technical retry actions for a mutation that could not be confirmed live
 * in `AccessSyncRetryControls` instead, inside the "Technical detail"
 * disclosure — see `useHumanAccessMutation`'s doc comment for why the two
 * are split.
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
      <RoleAndStatusHelp />
      <div className="inventory-table" role="table" aria-label="Users">
        <div className="inventory-row inventory-head" role="row">
          <span role="columnheader">User</span>
          <span role="columnheader">Access</span>
          <span role="columnheader">Actions</span>
        </div>
        {members.map((member) => (
          <div className="inventory-row" role="row" key={member.id}>
            <strong role="cell">
              {member.email}
              <small>{roleDisplayLabel[member.role]}</small>
            </strong>
            <span role="cell" className="state-label">
              {membershipStatusDisplayLabel[member.status]}
            </span>
            <div role="cell" className="member-actions">
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
            </div>
          </div>
        ))}
      </div>
      <MemberActionConfirmDialog
        pendingAction={pendingAction}
        confirmation={confirmation}
        onConfirm={confirmPendingAction}
        onCancel={() => setPendingAction(null)}
      />
    </>
  );
}

