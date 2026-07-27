import {
  createInvitationEligibilitySyncOperationId,
  isInvitationAccessEligible,
  isInvitationClaimable,
  isMembershipStatusTransitionAllowed,
  readInvitationIdFromEligibilitySyncOperation,
  type EligibilitySyncOperationId,
  type HumanAccessStore,
  type HumanInvitation,
  type HumanMembership,
} from "./human-access";

export function createInMemoryHumanAccessStore({
  memberships = [],
  invitations = [],
}: {
  memberships?: ReadonlyArray<HumanMembership>;
  invitations?: ReadonlyArray<HumanInvitation>;
} = {}): HumanAccessStore {
  const membershipRecords = new Map(
    memberships.map((membership) => [membership.id, membership]),
  );
  const invitationRecords = new Map(
    invitations.map((invitation) => [invitation.id, invitation]),
  );
  const pendingSync = new Map<
    EligibilitySyncOperationId,
    { siteId: HumanInvitation["siteId"]; attempts: number; nextAttemptAt: string }
  >();

  return {
    async findMembershipByIdentity({ siteId, binding }) {
      const matches = [...membershipRecords.values()].filter(
        (membership) =>
          membership.siteId === siteId &&
          membership.identityBinding.issuer === binding.issuer &&
          membership.identityBinding.subject === binding.subject,
      );
      return (
        matches.find((membership) => membership.status !== "revoked") ??
        matches.find((membership) => membership.status === "revoked") ??
        null
      );
    },
    async listMemberships(siteId) {
      return [...membershipRecords.values()].filter(
        (membership) => membership.siteId === siteId,
      );
    },
    async listAccessEligibleEmails({ siteId, now }) {
      return [
        ...new Set([
          ...[...membershipRecords.values()]
            .filter(
              (membership) =>
                membership.siteId === siteId &&
                membership.status === "active",
            )
            .map((membership) => membership.email),
          ...[...invitationRecords.values()]
            .filter(
              (invitation) =>
                invitation.siteId === siteId &&
                isInvitationAccessEligible(invitation, now),
            )
            .map((invitation) => invitation.email),
        ]),
      ].sort();
    },
    async findClaimableInvitation({ siteId, email, now }) {
      return (
        [...invitationRecords.values()].find(
          (invitation) =>
            invitation.siteId === siteId &&
            invitation.email === email &&
            isInvitationClaimable(invitation, now),
        ) ?? null
      );
    },
    async saveInvitationIfEmailAvailable(invitation) {
      const emailAlreadyBound = [...membershipRecords.values()].some(
        (membership) =>
          membership.siteId === invitation.siteId &&
          membership.email === invitation.email &&
          membership.status !== "revoked",
      );
      if (emailAlreadyBound) {
        return false;
      }
      for (const [id, candidate] of invitationRecords) {
        if (
          candidate.siteId === invitation.siteId &&
          candidate.email === invitation.email &&
          (candidate.status === "pending_access_sync" ||
            candidate.status === "pending_acceptance")
        ) {
          invitationRecords.set(id, { ...candidate, status: "revoked" });
        }
      }
      invitationRecords.set(invitation.id, invitation);
      pendingSync.set(
        createInvitationEligibilitySyncOperationId(invitation.id),
        {
          siteId: invitation.siteId,
          attempts: 0,
          nextAttemptAt: new Date(0).toISOString(),
        },
      );
      return true;
    },
    async claimInvitation({ invitationId, membership, now }) {
      const invitation = invitationRecords.get(invitationId);
      if (
        invitation === undefined ||
        invitation.email !== membership.email ||
        !isInvitationClaimable(invitation, now)
      ) {
        return null;
      }
      const identityAlreadyBound = [...membershipRecords.values()].some(
        (candidate) =>
          candidate.siteId === membership.siteId &&
          candidate.identityBinding.issuer ===
            membership.identityBinding.issuer &&
          candidate.identityBinding.subject ===
            membership.identityBinding.subject &&
          candidate.status !== "revoked",
      );
      if (identityAlreadyBound) {
        return null;
      }
      const emailAlreadyBound = [...membershipRecords.values()].some(
        (candidate) =>
          candidate.siteId === membership.siteId &&
          candidate.email === membership.email &&
          candidate.status !== "revoked",
      );
      if (emailAlreadyBound) {
        return null;
      }
      invitationRecords.set(invitationId, {
        ...invitation,
        status: "claimed",
      });
      membershipRecords.set(membership.id, membership);
      return membership;
    },
    async changeMembershipStatus({
      siteId,
      membershipId,
      status,
      syncOperationId,
    }) {
      const membership = membershipRecords.get(membershipId);
      if (membership?.siteId !== siteId) {
        return { changed: false, reason: "membership_not_found" };
      }
      if (!isMembershipStatusTransitionAllowed(membership.status, status)) {
        return {
          changed: false,
          reason: "membership_transition_not_allowed",
        };
      }
      if (
        membership.role === "owner" &&
        membership.status === "active" &&
        status !== "active"
      ) {
        const activeOwnerCount = [...membershipRecords.values()].filter(
          (candidate) =>
            candidate.siteId === siteId &&
            candidate.role === "owner" &&
            candidate.status === "active",
        ).length;
        if (activeOwnerCount <= 1) {
          return { changed: false, reason: "last_owner" };
        }
      }
      const updated = { ...membership, status };
      membershipRecords.set(membershipId, updated);
      pendingSync.set(syncOperationId, {
        siteId,
        attempts: 0,
        nextAttemptAt: new Date(0).toISOString(),
      });
      return { changed: true, membership: updated };
    },
    async markEligibilitySynchronized({ siteId, operationIds, now }) {
      const invitationIds = new Set(
        operationIds
          .map(readInvitationIdFromEligibilitySyncOperation)
          .filter((id) => id !== null),
      );
      for (const [id, invitation] of invitationRecords) {
        if (
          invitationIds.has(id) &&
          invitation.siteId === siteId &&
          invitation.status === "pending_access_sync" &&
          invitation.expiresAt > now
        ) {
          invitationRecords.set(id, {
            ...invitation,
            status: "pending_acceptance",
          });
        }
      }
      for (const operationId of operationIds) {
        if (pendingSync.get(operationId)?.siteId === siteId) {
          pendingSync.delete(operationId);
        }
      }
    },
    async recordEligibilitySyncFailure({ siteId, operationIds, now }) {
      for (const id of operationIds) {
        const work = pendingSync.get(id);
        if (work === undefined || work.siteId !== siteId) {
          continue;
        }
        const delays = [5, 30, 120, 900];
        const delaySeconds =
          delays[Math.min(work.attempts, delays.length - 1)]!;
        pendingSync.set(id, {
          siteId: work.siteId,
          attempts: work.attempts + 1,
          nextAttemptAt: new Date(
            new Date(now).getTime() + delaySeconds * 1_000,
          ).toISOString(),
        });
      }
    },
    async listPendingEligibilitySync({ siteId, now, dueOnly }) {
      return [...pendingSync.entries()]
        .filter(
          ([, work]) =>
            work.siteId === siteId &&
            (!dueOnly || work.nextAttemptAt <= now),
        )
        .map(([id]) => id)
        .sort();
    },
  };
}
