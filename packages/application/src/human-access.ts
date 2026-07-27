import type { SiteId } from "@foundry/site-definition";

declare const humanIdBrand: unique symbol;

export type HumanMembershipId = string & {
  readonly [humanIdBrand]: "membership";
};
export type HumanInvitationId = string & {
  readonly [humanIdBrand]: "invitation";
};
export type HumanUserId = string & {
  readonly [humanIdBrand]: "user";
};
export type EligibilitySyncOperationId = string & {
  readonly [humanIdBrand]: "eligibility_sync";
};

export const createHumanMembershipId = (value: string) =>
  value as HumanMembershipId;
export const createHumanInvitationId = (value: string) =>
  value as HumanInvitationId;
export const createHumanUserId = (value: string) => value as HumanUserId;
export const createEligibilitySyncOperationId = (value: string) =>
  value as EligibilitySyncOperationId;

const invitationSyncPrefix = "invitation:";
export function createInvitationEligibilitySyncOperationId(
  invitationId: HumanInvitationId,
) {
  return createEligibilitySyncOperationId(
    `${invitationSyncPrefix}${invitationId}`,
  );
}
export function readInvitationIdFromEligibilitySyncOperation(
  operationId: EligibilitySyncOperationId,
): HumanInvitationId | null {
  return operationId.startsWith(invitationSyncPrefix)
    ? createHumanInvitationId(operationId.slice(invitationSyncPrefix.length))
    : null;
}

export type HumanRole = "owner" | "editor";
export type MembershipStatus = "active" | "suspended" | "revoked";
export const membershipStatuses = [
  "active",
  "suspended",
  "revoked",
] as const satisfies ReadonlyArray<MembershipStatus>;
export function isMembershipStatus(value: unknown): value is MembershipStatus {
  return membershipStatuses.some((status) => status === value);
}
export type InvitationStatus =
  | "pending_access_sync"
  | "pending_acceptance"
  | "claimed"
  | "revoked"
  | "expired";
export type HumanCapability =
  | "dashboard.view"
  | "content.write"
  | "access.manage";

export type ExternalIdentityBinding = Readonly<{
  issuer: string;
  subject: string;
}>;

export type ExternalHumanIdentity = Readonly<{
  binding: ExternalIdentityBinding;
  email: string;
  nonce: string;
}>;

export type HumanMembership = Readonly<{
  id: HumanMembershipId;
  siteId: SiteId;
  userId: HumanUserId;
  email: string;
  identityBinding: ExternalIdentityBinding;
  role: HumanRole;
  status: MembershipStatus;
}>;

export type HumanInvitation = Readonly<{
  id: HumanInvitationId;
  siteId: SiteId;
  email: string;
  role: HumanRole;
  status: InvitationStatus;
  expiresAt: string;
  invitedByMembershipId: HumanMembershipId | null;
}>;

export type MembershipStatusChange =
  | Readonly<{ changed: true; membership: HumanMembership }>
  | Readonly<{
      changed: false;
      reason:
        | "membership_not_found"
        | "last_owner"
        | "membership_transition_not_allowed";
    }>;

export interface HumanAccessStore {
  findMembershipByIdentity(input: {
    siteId: SiteId;
    binding: ExternalIdentityBinding;
  }): Promise<HumanMembership | null>;
  listMemberships(siteId: SiteId): Promise<ReadonlyArray<HumanMembership>>;
  listAccessEligibleEmails(input: {
    siteId: SiteId;
    now: string;
  }): Promise<ReadonlyArray<string>>;
  findClaimableInvitation(input: {
    siteId: SiteId;
    email: string;
    now: string;
  }): Promise<HumanInvitation | null>;
  saveInvitationIfEmailAvailable(
    invitation: HumanInvitation,
  ): Promise<boolean>;
  claimInvitation(input: {
    invitationId: HumanInvitationId;
    membership: HumanMembership;
    now: string;
  }): Promise<HumanMembership | null>;
  changeMembershipStatus(input: {
    siteId: SiteId;
    membershipId: HumanMembershipId;
    status: MembershipStatus;
    now: string;
    syncOperationId: EligibilitySyncOperationId;
  }): Promise<MembershipStatusChange>;
  markEligibilitySynchronized(input: {
    siteId: SiteId;
    operationIds: ReadonlyArray<EligibilitySyncOperationId>;
    now: string;
  }): Promise<void>;
  recordEligibilitySyncFailure(input: {
    siteId: SiteId;
    operationIds: ReadonlyArray<EligibilitySyncOperationId>;
    now: string;
  }): Promise<void>;
  listPendingEligibilitySync(input: {
    siteId: SiteId;
    now: string;
    dueOnly: boolean;
  }): Promise<ReadonlyArray<EligibilitySyncOperationId>>;
}

export interface HumanAccessEligibilitySynchronizer {
  replaceExactEmailEligibility(
    emails: ReadonlyArray<string>,
  ): Promise<void>;
}

export type HumanAccessApplication = Readonly<{
  queries: Readonly<{
    requireCapability(input: {
      actor: ExternalHumanIdentity;
      capability: HumanCapability;
    }): Promise<HumanMembership>;
    listMembers(input: {
      actor: ExternalHumanIdentity;
    }): Promise<ReadonlyArray<HumanMembership>>;
    canActivateInvitation(input: {
      actor: ExternalHumanIdentity;
    }): Promise<boolean>;
  }>;
  commands: Readonly<{
    invite(input: {
      actor: ExternalHumanIdentity;
      email: string;
      role: HumanRole;
    }): Promise<HumanInvitation>;
    activateInvitation(input: {
      actor: ExternalHumanIdentity;
    }): Promise<HumanMembership>;
    changeStatus(input: {
      actor: ExternalHumanIdentity;
      membershipId: HumanMembershipId;
      status: MembershipStatus;
    }): Promise<HumanMembership>;
    reconcileEligibility(input: {
      actor: ExternalHumanIdentity;
    }): Promise<void>;
  }>;
}>;

export class AccessDeniedError extends Error {
  readonly code:
    | "membership_not_found"
    | "membership_not_active"
    | "capability_not_authorized"
    | "invitation_not_claimable"
    | "membership_email_ambiguous"
    | "membership_transition_not_allowed";

  constructor(code: AccessDeniedError["code"]) {
    super(code);
    this.name = "AccessDeniedError";
    this.code = code;
  }
}

export class LastOwnerError extends Error {
  constructor() {
    super("last_owner");
    this.name = "LastOwnerError";
  }
}

export class InvalidHumanEmailError extends Error {
  constructor() {
    super("invalid_human_email");
    this.name = "InvalidHumanEmailError";
  }
}

export class EligibilitySyncConvergenceError extends Error {
  constructor() {
    super("access_eligibility_sync_did_not_converge");
    this.name = "EligibilitySyncConvergenceError";
  }
}

export function normalizeHumanEmail(value: unknown): string {
  if (typeof value !== "string") {
    throw new InvalidHumanEmailError();
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    throw new InvalidHumanEmailError();
  }
  return normalized;
}

export function isInvitationAccessEligible(
  invitation: HumanInvitation,
  now: string,
) {
  return (
    invitation.expiresAt > now &&
    (invitation.status === "pending_access_sync" ||
      invitation.status === "pending_acceptance")
  );
}

export function isInvitationClaimable(
  invitation: HumanInvitation,
  now: string,
) {
  return (
    invitation.status === "pending_acceptance" &&
    invitation.expiresAt > now
  );
}

export function isMembershipStatusTransitionAllowed(
  current: MembershipStatus,
  next: MembershipStatus,
) {
  return current !== "revoked" || next === "revoked";
}

export function availableMembershipStatusActions(
  current: MembershipStatus,
): ReadonlyArray<MembershipStatus> {
  const actions: Readonly<Record<MembershipStatus, ReadonlyArray<MembershipStatus>>> =
    {
      active: ["suspended", "revoked"],
      suspended: ["active", "revoked"],
      revoked: [],
    };
  return actions[current];
}

const roleCapabilities: Readonly<
  Record<HumanRole, ReadonlySet<HumanCapability>>
> = {
  owner: new Set(["dashboard.view", "content.write", "access.manage"]),
  editor: new Set(["dashboard.view", "content.write"]),
};
const invitationLifetimeMs = 7 * 24 * 60 * 60 * 1_000;
const maximumEligibilitySyncAttempts = 3;

function sameEmails(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
) {
  return (
    left.length === right.length &&
    left.every((email, index) => email === right[index])
  );
}

export async function reconcileHumanAccessEligibility({
  siteId,
  store,
  eligibilitySynchronizer,
  now,
  mode,
}: {
  siteId: SiteId;
  store: HumanAccessStore;
  eligibilitySynchronizer: HumanAccessEligibilitySynchronizer;
  now: string;
  mode: "pending" | "scheduled" | "ensure";
}) {
  const allPendingOperationIds = await store.listPendingEligibilitySync({
    siteId,
    now,
    dueOnly: false,
  });
  const operationIds =
    mode === "scheduled"
      ? await store.listPendingEligibilitySync({
          siteId,
          now,
          dueOnly: true,
        })
      : allPendingOperationIds;
  if (operationIds.length === 0) {
    if (allPendingOperationIds.length > 0 || mode === "pending") {
      return;
    }
  }
  try {
    let eligibleEmails = await store.listAccessEligibleEmails({
      siteId,
      now,
    });
    for (
      let attempt = 0;
      attempt < maximumEligibilitySyncAttempts;
      attempt += 1
    ) {
      await eligibilitySynchronizer.replaceExactEmailEligibility(
        eligibleEmails,
      );
      const latestEligibleEmails = await store.listAccessEligibleEmails({
        siteId,
        now,
      });
      if (sameEmails(eligibleEmails, latestEligibleEmails)) {
        await store.markEligibilitySynchronized({
          siteId,
          operationIds,
          now,
        });
        return;
      }
      eligibleEmails = latestEligibleEmails;
    }
    throw new EligibilitySyncConvergenceError();
  } catch (error) {
    await store.recordEligibilitySyncFailure({
      siteId,
      operationIds,
      now,
    });
    throw error;
  }
}

export function createHumanAccessApplication({
  siteId,
  store,
  eligibilitySynchronizer,
  clock = () => new Date(),
  createId = (kind) => `${kind}-${crypto.randomUUID()}`,
}: {
  siteId: SiteId;
  store: HumanAccessStore;
  eligibilitySynchronizer: HumanAccessEligibilitySynchronizer;
  clock?: () => Date;
  createId?: (
    kind: "invitation" | "membership" | "user" | "access_sync",
  ) => string;
}): HumanAccessApplication {
  async function synchronizeEligibility() {
    const now = clock().toISOString();
    await reconcileHumanAccessEligibility({
      siteId,
      store,
      eligibilitySynchronizer,
      now,
      mode: "pending",
    });
  }

  async function requireCapability({
    actor,
    capability,
  }: {
    actor: ExternalHumanIdentity;
    capability: HumanCapability;
  }): Promise<HumanMembership> {
    const membership = await store.findMembershipByIdentity({
      siteId,
      binding: actor.binding,
    });
    if (membership === null) {
      throw new AccessDeniedError("membership_not_found");
    }
    if (membership.status !== "active") {
      throw new AccessDeniedError("membership_not_active");
    }
    if (!roleCapabilities[membership.role].has(capability)) {
      throw new AccessDeniedError("capability_not_authorized");
    }
    return membership;
  }

  async function changeStatus({
    actor,
    membershipId,
    status,
  }: {
    actor: ExternalHumanIdentity;
    membershipId: HumanMembershipId;
    status: MembershipStatus;
  }): Promise<HumanMembership> {
    await requireCapability({ actor, capability: "access.manage" });
    const result = await store.changeMembershipStatus({
      siteId,
      membershipId,
      status,
      now: clock().toISOString(),
      syncOperationId: createEligibilitySyncOperationId(
        createId("access_sync"),
      ),
    });
    if (!result.changed) {
      if (result.reason === "last_owner") {
        throw new LastOwnerError();
      }
      if (result.reason === "membership_transition_not_allowed") {
        throw new AccessDeniedError("membership_transition_not_allowed");
      }
      throw new AccessDeniedError("membership_not_found");
    }
    await synchronizeEligibility();
    return result.membership;
  }

  const queries: HumanAccessApplication["queries"] = Object.freeze({
    requireCapability,
    async listMembers({ actor }) {
      await requireCapability({ actor, capability: "access.manage" });
      return store.listMemberships(siteId);
    },
    async canActivateInvitation({ actor }) {
      return (
        (await store.findClaimableInvitation({
          siteId,
          email: normalizeHumanEmail(actor.email),
          now: clock().toISOString(),
        })) !== null
      );
    },
  });
  const commands: HumanAccessApplication["commands"] = Object.freeze({
    async invite({ actor, email, role }) {
      const owner = await requireCapability({
        actor,
        capability: "access.manage",
      });
      const createdAt = clock();
      const normalizedEmail = normalizeHumanEmail(email);
      const invitation: HumanInvitation = {
        id: createHumanInvitationId(createId("invitation")),
        siteId,
        email: normalizedEmail,
        role,
        status: "pending_access_sync",
        expiresAt: new Date(
          createdAt.getTime() + invitationLifetimeMs,
        ).toISOString(),
        invitedByMembershipId: owner.id,
      };
      if (!(await store.saveInvitationIfEmailAvailable(invitation))) {
        throw new AccessDeniedError("membership_email_ambiguous");
      }
      await synchronizeEligibility();
      return { ...invitation, status: "pending_acceptance" };
    },
    async activateInvitation({ actor }) {
      const now = clock().toISOString();
      const invitation = await store.findClaimableInvitation({
        siteId,
        email: normalizeHumanEmail(actor.email),
        now,
      });
      if (invitation === null) {
        throw new AccessDeniedError("invitation_not_claimable");
      }
      const membership = await store.claimInvitation({
        invitationId: invitation.id,
        membership: {
          id: createHumanMembershipId(createId("membership")),
          siteId,
          userId: createHumanUserId(createId("user")),
          email: invitation.email,
          identityBinding: actor.binding,
          role: invitation.role,
          status: "active",
        },
        now,
      });
      if (membership === null) {
        throw new AccessDeniedError("invitation_not_claimable");
      }
      return membership;
    },
    changeStatus,
    async reconcileEligibility({ actor }) {
      await requireCapability({ actor, capability: "access.manage" });
      await reconcileHumanAccessEligibility({
        siteId,
        store,
        eligibilitySynchronizer,
        now: clock().toISOString(),
        mode: "ensure",
      });
    },
  });

  return Object.freeze({ queries, commands });
}
