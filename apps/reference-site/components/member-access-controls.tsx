"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";

import type {
  HumanMembership,
  MembershipStatus,
} from "@foundry/application";
import { availableMembershipStatusActions } from "@foundry/application";
import {
  createHumanAccessMutationAttempt,
  isHumanAccessMutationAmbiguousFailure,
  isHumanAccessMutationInProgress,
  isHumanAccessMutationRequestCheckFailed,
  isHumanAccessMutationRequestCheckUnavailable,
  membershipStatusConfirmation,
  sendHumanAccessMutationAttempt,
  type HumanAccessMutationAttempt,
} from "../src/human-access-mutation-client";

const statusActionLabels: Readonly<Record<MembershipStatus, string>> = {
  active: "Activate",
  suspended: "Suspend",
  revoked: "Revoke",
};

export function MemberAccessControls({
  csrfToken,
  members,
}: {
  csrfToken: string;
  members: ReadonlyArray<HumanMembership>;
}) {
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

  async function reconcileAccess() {
    await send({ action: "reconcile_access" });
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const completed = await send({
      action: "invite",
      email: data.get("email"),
      role: data.get("role"),
    });
    if (completed) {
      form.reset();
    }
  }

  async function changeStatus(
    membershipId: HumanMembership["id"],
    status: MembershipStatus,
  ) {
    const member = members.find((candidate) => candidate.id === membershipId);
    if (member === undefined) {
      setMessage("The member is no longer available. Refresh and try again.");
      return;
    }
    const confirmation = membershipStatusConfirmation(member.email, status);
    if (confirmation !== null && !window.confirm(confirmation)) {
      return;
    }
    await send({ action: "change_status", membershipId, status });
  }

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
          disabled={pending || retryAvailable}
        >
          Invite member
        </button>
      </form>
      <p role="status" aria-live="polite">
        {message}
      </p>
      {retryAvailable ? (
        <button
          className="copy-button"
          type="button"
          disabled={pending}
          onClick={() => send()}
        >
          Retry access change
        </button>
      ) : null}
      {syncPending ? (
        <button
          className="copy-button"
          type="button"
          disabled={pending || retryAvailable}
          onClick={reconcileAccess}
        >
          Retry Cloudflare sync
        </button>
      ) : null}
      <div className="inventory-table" role="table" aria-label="Members">
        <div className="inventory-row inventory-head" role="row">
          <span role="columnheader">Member</span>
          <span role="columnheader">Access</span>
          <span role="columnheader">Actions</span>
        </div>
        {members.map((member) => (
          <div className="inventory-row" role="row" key={member.id}>
            <strong role="cell">
              {member.email}
              <small>{member.role}</small>
            </strong>
            <span role="cell" className="state-label">
              {member.status}
            </span>
            <div role="cell" className="member-actions">
              {availableMembershipStatusActions(member.status).map(
                (status) => (
                <button
                  key={status}
                  type="button"
                  disabled={pending || retryAvailable}
                  onClick={() => changeStatus(member.id, status)}
                >
                  {statusActionLabels[status]}
                </button>
                ),
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
