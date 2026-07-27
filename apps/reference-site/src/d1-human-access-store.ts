import type {
  HumanAccessStore,
  HumanInvitation,
  HumanMembership,
  HumanRole,
  InvitationStatus,
  MembershipStatus,
} from "@foundry/application";
import {
  createEligibilitySyncOperationId,
  createHumanInvitationId,
  createHumanMembershipId,
  createHumanUserId,
  createInvitationEligibilitySyncOperationId,
  isMembershipStatusTransitionAllowed,
  readInvitationIdFromEligibilitySyncOperation,
} from "@foundry/application";
import type { SiteId } from "@foundry/site-definition";

type D1Result = Readonly<{
  success: boolean;
  meta: Readonly<{ changes?: number }>;
}>;

type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<Readonly<{ results: T[] }>>;
  run(): Promise<D1Result>;
};

export type D1DatabaseSessionBinding = {
  prepare(query: string): D1PreparedStatement;
  batch(
    statements: ReadonlyArray<D1PreparedStatement>,
  ): Promise<ReadonlyArray<D1Result>>;
  getBookmark(): string | null;
};

export type D1DatabaseBinding = {
  prepare(query: string): D1PreparedStatement;
  batch(
    statements: ReadonlyArray<D1PreparedStatement>,
  ): Promise<ReadonlyArray<D1Result>>;
  withSession?(
    constraint?: "first-primary" | string,
  ): D1DatabaseSessionBinding;
};

type MembershipRow = {
  id: string;
  site_id: string;
  user_id: string;
  email: string;
  issuer: string;
  subject: string;
  role: HumanRole;
  status: MembershipStatus;
};

type InvitationRow = {
  id: string;
  site_id: string;
  email: string;
  role: HumanRole;
  status: InvitationStatus;
  expires_at: string;
  invited_by_membership_id: string | null;
};

const membershipProjection = `
  SELECT
    membership.id,
    membership.site_id,
    membership.user_id,
    membership.email,
    membership.identity_issuer AS issuer,
    membership.identity_subject AS subject,
    membership.role,
    membership.status
  FROM human_memberships AS membership
`;

const maximumIdsPerStatement = 98;

function chunks<T>(
  values: ReadonlyArray<T>,
  size = maximumIdsPerStatement,
): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function toMembership(row: MembershipRow): HumanMembership {
  return {
    id: createHumanMembershipId(row.id),
    siteId: row.site_id as SiteId,
    userId: createHumanUserId(row.user_id),
    email: row.email,
    identityBinding: {
      issuer: row.issuer,
      subject: row.subject,
    },
    role: row.role,
    status: row.status,
  };
}

function toInvitation(row: InvitationRow): HumanInvitation {
  return {
    id: createHumanInvitationId(row.id),
    siteId: row.site_id as SiteId,
    email: row.email,
    role: row.role,
    status: row.status,
    expiresAt: row.expires_at,
    invitedByMembershipId:
      row.invited_by_membership_id === null
        ? null
        : createHumanMembershipId(row.invited_by_membership_id),
  };
}

export function createD1HumanAccessStore(
  database: D1DatabaseBinding,
): HumanAccessStore {
  async function findMembershipById({
    siteId,
    membershipId,
  }: {
    siteId: SiteId;
    membershipId: string;
  }): Promise<HumanMembership | null> {
    const row = await database
      .prepare(
        `${membershipProjection}
         WHERE membership.site_id = ?1 AND membership.id = ?2`,
      )
      .bind(siteId, membershipId)
      .first<MembershipRow>();
    return row === null ? null : toMembership(row);
  }

  return {
    async findMembershipByIdentity({ siteId, binding }) {
      const row = await database
        .prepare(
          `${membershipProjection}
           WHERE membership.site_id = ?1
             AND membership.user_id = (
               SELECT user_id FROM human_external_identities
               WHERE site_id = ?1
                 AND issuer = ?2
                 AND subject = ?3
             )`,
        )
        .bind(siteId, binding.issuer, binding.subject)
        .first<MembershipRow>();
      return row === null ? null : toMembership(row);
    },
    async listMemberships(siteId) {
      const rows = await database
        .prepare(
          `${membershipProjection}
           WHERE membership.site_id = ?1
           ORDER BY membership.email, membership.id`,
        )
        .bind(siteId)
        .all<MembershipRow>();
      return rows.results.map(toMembership);
    },
    async listAccessEligibleEmails({ siteId, now }) {
      const rows = await database
        .prepare(
          `SELECT email
           FROM human_memberships AS membership
           WHERE membership.site_id = ?1
             AND membership.status = 'active'
           UNION
           SELECT email
           FROM human_invitations
           WHERE site_id = ?1
             AND status IN ('pending_access_sync', 'pending_acceptance')
             AND expires_at > ?2
           ORDER BY email`,
        )
        .bind(siteId, now)
        .all<{ email: string }>();
      return rows.results.map((row) => row.email);
    },
    async findClaimableInvitation({ siteId, email, now }) {
      const row = await database
        .prepare(
          `SELECT
             id, site_id, email, role, status, expires_at,
             invited_by_membership_id
           FROM human_invitations
           WHERE site_id = ?1
             AND email = ?2
             AND status = 'pending_acceptance'
             AND expires_at > ?3`,
        )
        .bind(siteId, email, now)
        .first<InvitationRow>();
      return row === null ? null : toInvitation(row);
    },
    async saveInvitationIfEmailAvailable(invitation) {
      const now = new Date(
        new Date(invitation.expiresAt).getTime() -
          7 * 24 * 60 * 60 * 1_000,
      ).toISOString();
      const results = await database.batch([
        database
          .prepare(
            `UPDATE human_invitations
             SET status = 'revoked'
             WHERE site_id = ?1
               AND email = ?2
               AND status IN ('pending_access_sync', 'pending_acceptance')
               AND NOT EXISTS (
                 SELECT 1 FROM human_memberships
                 WHERE site_id = ?1
                   AND email = ?2
                   AND status <> 'revoked'
               )`,
          )
          .bind(invitation.siteId, invitation.email),
        database
          .prepare(
            `INSERT INTO human_invitations (
               id, site_id, email, role, status, expires_at,
               invited_by_membership_id, created_at
             )
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
             WHERE NOT EXISTS (
               SELECT 1 FROM human_memberships
               WHERE site_id = ?2
                 AND email = ?3
                 AND status <> 'revoked'
             )`,
          )
          .bind(
            invitation.id,
            invitation.siteId,
            invitation.email,
            invitation.role,
            invitation.status,
            invitation.expiresAt,
            invitation.invitedByMembershipId,
            now,
          ),
        database
          .prepare(
            `INSERT INTO human_access_audit_events (
               site_id, event_type, subject_id, occurred_at
             )
             SELECT ?1, 'invitation.created', ?2, ?3
             WHERE EXISTS (
               SELECT 1 FROM human_invitations
               WHERE id = ?2 AND site_id = ?1
             )`,
          )
          .bind(invitation.siteId, invitation.id, now),
        database
          .prepare(
            `INSERT INTO human_access_sync_outbox (
               id, site_id, status, next_attempt_at, created_at
             )
             SELECT ?1, ?2, 'pending', ?3, ?3
             WHERE EXISTS (
               SELECT 1 FROM human_invitations
               WHERE id = ?4 AND site_id = ?2
             )`,
          )
          .bind(
            createInvitationEligibilitySyncOperationId(invitation.id),
            invitation.siteId,
            now,
            invitation.id,
          ),
      ]);
      return (results[1]?.meta.changes ?? 0) > 0;
    },
    async claimInvitation({ invitationId, membership, now }) {
      const results = await database.batch([
        database
          .prepare(
            `INSERT INTO human_users (id, email, created_at)
             SELECT ?1, ?2, ?3
             WHERE EXISTS (
               SELECT 1 FROM human_invitations
               WHERE id = ?4
                 AND site_id = ?5
                 AND email = ?2
                 AND status = 'pending_acceptance'
                 AND expires_at > ?3
             )
             AND NOT EXISTS (
               SELECT 1 FROM human_memberships
               WHERE site_id = ?5
                 AND email = ?2
                 AND status <> 'revoked'
             )
             AND NOT EXISTS (
               SELECT 1
               FROM human_external_identities AS identity
               JOIN human_memberships AS bound_membership
                 ON bound_membership.site_id = identity.site_id
                AND bound_membership.user_id = identity.user_id
                AND bound_membership.status <> 'revoked'
               WHERE identity.site_id = ?5
                 AND identity.issuer = ?6
                 AND identity.subject = ?7
             )`,
          )
          .bind(
            membership.userId,
            membership.email,
            now,
            invitationId,
            membership.siteId,
            membership.identityBinding.issuer,
            membership.identityBinding.subject,
          ),
        database
          .prepare(
            `INSERT INTO human_access_audit_events (
               site_id, event_type, subject_id, occurred_at
             )
             SELECT ?1, 'identity.rebound', ?2, ?3
             WHERE EXISTS (
               SELECT 1 FROM human_external_identities AS identity
               WHERE identity.site_id = ?1
                 AND identity.issuer = ?4
                 AND identity.subject = ?5
                 AND identity.user_id <> ?6
                 AND NOT EXISTS (
                   SELECT 1 FROM human_memberships AS bound_membership
                   WHERE bound_membership.site_id = identity.site_id
                     AND bound_membership.user_id = identity.user_id
                     AND bound_membership.status <> 'revoked'
                 )
             )`,
          )
          .bind(
            membership.siteId,
            membership.id,
            now,
            membership.identityBinding.issuer,
            membership.identityBinding.subject,
            membership.userId,
          ),
        database
          .prepare(
            `INSERT INTO human_external_identities (
               site_id, issuer, subject, user_id, created_at
             )
             SELECT ?1, ?2, ?3, ?4, ?5
             WHERE EXISTS (
               SELECT 1 FROM human_users WHERE id = ?4
             )
             ON CONFLICT (site_id, issuer, subject) DO UPDATE SET
               user_id = excluded.user_id,
               created_at = excluded.created_at
             WHERE NOT EXISTS (
               SELECT 1 FROM human_memberships AS bound_membership
               WHERE bound_membership.site_id = excluded.site_id
                 AND bound_membership.user_id =
                   human_external_identities.user_id
                 AND bound_membership.status <> 'revoked'
             )`,
          )
          .bind(
            membership.siteId,
            membership.identityBinding.issuer,
            membership.identityBinding.subject,
            membership.userId,
            now,
          ),
        database
          .prepare(
            `INSERT INTO human_memberships (
               id, site_id, user_id, email, identity_issuer,
               identity_subject, role, status, created_at, updated_at
             )
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', ?8, ?8
             WHERE EXISTS (
               SELECT 1 FROM human_external_identities
               WHERE site_id = ?2
                 AND issuer = ?5
                 AND subject = ?6
                 AND user_id = ?3
             )
             ON CONFLICT DO NOTHING`,
          )
          .bind(
            membership.id,
            membership.siteId,
            membership.userId,
            membership.email,
            membership.identityBinding.issuer,
            membership.identityBinding.subject,
            membership.role,
            now,
          ),
        database
          .prepare(
            `UPDATE human_invitations
             SET status = 'claimed', claimed_at = ?1
             WHERE id = ?2
               AND site_id = ?3
               AND email = ?4
               AND status = 'pending_acceptance'
               AND expires_at > ?1
               AND EXISTS (
                 SELECT 1 FROM human_memberships
                 WHERE id = ?5 AND site_id = ?3
               )`,
          )
          .bind(
            now,
            invitationId,
            membership.siteId,
            membership.email,
            membership.id,
          ),
        database
          .prepare(
            `INSERT INTO human_access_audit_events (
               site_id, event_type, subject_id, occurred_at
             )
             SELECT ?1, 'membership.activated', ?2, ?3
             WHERE EXISTS (
               SELECT 1 FROM human_memberships WHERE id = ?2 AND site_id = ?1
             )`,
          )
          .bind(membership.siteId, membership.id, now),
      ]);

      if ((results[3]?.meta.changes ?? 0) < 1) {
        return null;
      }
      return findMembershipById({
        siteId: membership.siteId,
        membershipId: membership.id,
      });
    },
    async changeMembershipStatus({
      siteId,
      membershipId,
      status,
      now,
      syncOperationId,
    }) {
      try {
        const existing = await findMembershipById({ siteId, membershipId });
        if (existing === null) {
          return { changed: false, reason: "membership_not_found" };
        }
        if (!isMembershipStatusTransitionAllowed(existing.status, status)) {
          return {
            changed: false,
            reason: "membership_transition_not_allowed",
          };
        }
        const results = await database.batch([
          database
            .prepare(
              `UPDATE human_memberships
               SET status = ?1, updated_at = ?2
               WHERE site_id = ?3
                 AND id = ?4
                 AND NOT (status = 'revoked' AND ?1 <> 'revoked')`,
            )
            .bind(status, now, siteId, membershipId),
          database
            .prepare(
              `INSERT INTO human_access_audit_events (
                 site_id, event_type, subject_id, occurred_at
               )
               SELECT ?1, ?2, ?3, ?4
               WHERE EXISTS (
                 SELECT 1 FROM human_memberships
                 WHERE site_id = ?1
                   AND id = ?3
                   AND status = ?5
                   AND updated_at = ?4
               )`,
            )
            .bind(
              siteId,
              `membership.${status}`,
              membershipId,
              now,
              status,
            ),
          database
            .prepare(
              `INSERT INTO human_access_sync_outbox (
                 id, site_id, status, next_attempt_at, created_at
               )
               SELECT ?1, ?2, 'pending', ?3, ?3
               WHERE EXISTS (
                 SELECT 1 FROM human_memberships
                 WHERE site_id = ?2
                   AND id = ?4
                   AND status = ?5
                   AND updated_at = ?3
               )`,
            )
            .bind(syncOperationId, siteId, now, membershipId, status),
        ]);
        const result = results[0]!;

        if ((result.meta.changes ?? 0) < 1) {
          return { changed: false, reason: "membership_not_found" };
        }

        const membership = await findMembershipById({
          siteId,
          membershipId,
        });
        if (membership === null) {
          return { changed: false, reason: "membership_not_found" };
        }
        return { changed: true, membership };
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.toLowerCase().includes("last_owner")
        ) {
          return { changed: false, reason: "last_owner" };
        }
        throw error;
      }
    },
    async markEligibilitySynchronized({ siteId, operationIds, now }) {
      if (operationIds.length === 0) {
        return;
      }
      for (const operationChunk of chunks(operationIds)) {
        const outboxPlaceholders = operationChunk
          .map((_, index) => `?${index + 3}`)
          .join(", ");
        const invitationIds = operationChunk
          .map(readInvitationIdFromEligibilitySyncOperation)
          .filter((id) => id !== null);
        const statements = [
          database
            .prepare(
              `UPDATE human_access_sync_outbox
               SET status = 'completed', completed_at = ?1
               WHERE site_id = ?2
                 AND status = 'pending'
                 AND id IN (${outboxPlaceholders})`,
            )
            .bind(now, siteId, ...operationChunk),
        ];
        if (invitationIds.length > 0) {
          const invitationPlaceholders = invitationIds
            .map((_, index) => `?${index + 3}`)
            .join(", ");
          statements.unshift(
            database
              .prepare(
                `UPDATE human_invitations
                 SET status = 'pending_acceptance'
                 WHERE site_id = ?1
                   AND status = 'pending_access_sync'
                   AND expires_at > ?2
                   AND id IN (${invitationPlaceholders})`,
              )
              .bind(siteId, now, ...invitationIds),
          );
        }
        await database.batch(statements);
      }
    },
    async recordEligibilitySyncFailure({
      siteId,
      operationIds,
      now,
    }) {
      if (operationIds.length === 0) {
        return;
      }
      for (const operationChunk of chunks(operationIds)) {
        const placeholders = operationChunk
          .map((_, index) => `?${index + 3}`)
          .join(", ");
        await database
          .prepare(
            `UPDATE human_access_sync_outbox
             SET
               attempts = attempts + 1,
               next_attempt_at = strftime(
                 '%Y-%m-%dT%H:%M:%fZ',
                 ?1,
                 CASE
                   WHEN attempts = 0 THEN '+5 seconds'
                   WHEN attempts = 1 THEN '+30 seconds'
                   WHEN attempts = 2 THEN '+2 minutes'
                   ELSE '+15 minutes'
                 END
               )
             WHERE site_id = ?2
               AND status = 'pending'
               AND id IN (${placeholders})`,
          )
          .bind(now, siteId, ...operationChunk)
          .run();
      }
    },
    async listPendingEligibilitySync({ siteId, now, dueOnly }) {
      const statement = database.prepare(
        `SELECT id
           FROM human_access_sync_outbox
           WHERE site_id = ?1
             AND status = 'pending'
             ${dueOnly ? "AND next_attempt_at <= ?2" : ""}
           ORDER BY id`,
      );
      const rows = await (dueOnly
        ? statement.bind(siteId, now)
        : statement.bind(siteId)
      ).all<{ id: string }>();
      return rows.results.map((row) =>
        createEligibilitySyncOperationId(row.id),
      );
    },
  };
}
