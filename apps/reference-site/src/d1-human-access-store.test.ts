import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  AccessDeniedError,
  createEligibilitySyncOperationId,
  createHumanAccessApplication,
  type ExternalHumanIdentity,
} from "@foundry/application";
import { createSiteId } from "@foundry/site-definition";

import {
  createD1HumanAccessStore,
  type D1DatabaseBinding,
} from "./d1-human-access-store";
import {
  executeIdempotentHumanMutation,
  HumanMutationExecutionNotStartedError,
  HumanMutationExecutionResumableError,
} from "./human-mutation-runtime";
import {
  type TestD1Database,
  useMigratedTestDatabase,
} from "./test-support/migrated-test-database";

const siteId = createSiteId("site_reference");
const owner: ExternalHumanIdentity = {
  binding: {
    issuer: "https://foundry.cloudflareaccess.com",
    subject: "owner-subject",
  },
  email: "owner@example.com",
  nonce: "owner-nonce",
};
const editor: ExternalHumanIdentity = {
  binding: {
    issuer: owner.binding.issuer,
    subject: "editor-subject",
  },
  email: "editor@example.com",
  nonce: "editor-nonce",
};
const now = new Date("2026-07-27T04:00:00.000Z");

let database: TestD1Database;
const testDatabase = useMigratedTestDatabase([
  "0001_human_access.sql",
  "0016_campaign_authoring.sql",
  "0021_campaign_test_delivery.sql",
]);

beforeEach(async () => {
  database = testDatabase.database;
  await database.batch([
    database
      .prepare(
        "INSERT INTO human_users (id, email, created_at) VALUES (?1, ?2, ?3)",
      )
      .bind("user-owner", owner.email, now.toISOString()),
    database
      .prepare(
        `INSERT INTO human_external_identities (
           site_id, issuer, subject, user_id, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(
        siteId,
        owner.binding.issuer,
        owner.binding.subject,
        "user-owner",
        now.toISOString(),
      ),
    database
      .prepare(
        `INSERT INTO human_memberships (
           id, site_id, user_id, email, identity_issuer, identity_subject,
           role, status, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'owner', 'active', ?7, ?7)`,
      )
      .bind(
        "membership-owner",
        siteId,
        "user-owner",
        owner.email,
        owner.binding.issuer,
        owner.binding.subject,
        now.toISOString(),
      ),
  ]);
});

describe("D1 human access store", () => {
  it("serializes Owner revocation against an active campaign test send lease", async () => {
    await database.batch([
      database
        .prepare(
          `INSERT INTO human_users (id, email, created_at)
           VALUES ('user-owner-secondary', 'secondary@example.com', ?1)`,
        )
        .bind(now.toISOString()),
      database
        .prepare(
          `INSERT INTO human_memberships (
             id, site_id, user_id, email, identity_issuer, identity_subject,
             role, status, created_at, updated_at
           ) VALUES (
             'membership-owner-secondary', ?1, 'user-owner-secondary',
             'secondary@example.com', 'https://foundry.cloudflareaccess.com',
             'owner-secondary', 'owner', 'active', ?2, ?2
           )`,
        )
        .bind(siteId, now.toISOString()),
      database
        .prepare(
          `INSERT INTO campaigns (
             id, site_id, lifecycle_state, current_revision_id,
             version, created_at, updated_at
           ) VALUES ('campaign-send-fence', ?1, 'draft',
             'revision-send-fence', 1, ?2, ?2)`,
        )
        .bind(siteId, now.toISOString()),
      database
        .prepare(
          `INSERT INTO campaign_revisions (
             id, site_id, campaign_id, revision_number,
             revision_json, created_at
           ) VALUES (
             'revision-send-fence', ?1, 'campaign-send-fence', 1, '{}', ?2
           )`,
        )
        .bind(siteId, now.toISOString()),
    ]);
    await database
      .prepare(
        `INSERT INTO campaign_test_deliveries (
           execution_id, site_id, actor_id, request_id, campaign_id,
           campaign_revision_id, binding_json, recipient_ids_json, state,
           attempt_number, attempt_lease_until, provider_campaign_id,
           foundry_send_proof, failure_code, evidence_json,
           created_at, updated_at
         ) VALUES (
           'execution-send-fence', ?1, 'membership-owner',
           'request-send-fence', 'campaign-send-fence',
           'revision-send-fence', '{}', '["membership-owner"]',
           'attempting', 1, '2026-07-27T04:01:00.000Z',
           'brevo-transactional-execution-send-fence', ?2,
           NULL, NULL, ?3, ?3
         )`,
      )
      .bind(siteId, "a".repeat(64), now.toISOString())
      .run();
    let current = now;
    const application = createHumanAccessApplication({
      siteId,
      store: createD1HumanAccessStore(
        database as unknown as D1DatabaseBinding,
      ),
      eligibilitySynchronizer: {
        async replaceExactEmailEligibility() {},
      },
      clock: () => current,
      createId: (kind) => `${kind}-send-fence`,
    });

    await expect(
      application.commands.changeStatus({
        actor: owner,
        membershipId: "membership-owner" as never,
        status: "suspended",
      }),
    ).rejects.toEqual(
      new AccessDeniedError("campaign_test_send_in_progress"),
    );
    await expect(
      database
        .prepare(
          `SELECT status FROM human_memberships
           WHERE id = 'membership-owner'`,
        )
        .first(),
    ).resolves.toEqual({ status: "active" });

    current = new Date("2026-07-27T04:01:01.000Z");
    await expect(
      application.commands.changeStatus({
        actor: owner,
        membershipId: "membership-owner" as never,
        status: "suspended",
      }),
    ).resolves.toMatchObject({ status: "suspended" });
  });

  it("replays a completed mutation receipt without executing twice", async () => {
    const request = new Request(
      "https://foundry.example/api/foundry-cms/members",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "mutation-replay-key",
        },
      },
    );
    const command = {
      action: "invite",
      email: editor.email,
      role: "editor",
    };
    let executions = 0;
    const execute = async () => {
      executions += 1;
      return Response.json({ invitationId: "invitation-editor" }, {
        status: 201,
      });
    };

    const first = await executeIdempotentHumanMutation({
      request,
      identity: owner,
      command,
      execute,
      database: database as unknown as D1DatabaseBinding,
    });
    const replay = await executeIdempotentHumanMutation({
      request,
      identity: owner,
      command,
      execute,
      database: database as unknown as D1DatabaseBinding,
    });

    expect(executions).toBe(1);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    await expect(replay.json()).resolves.toEqual({
      invitationId: "invitation-editor",
    });
    await expect(
      executeIdempotentHumanMutation({
        request,
        identity: owner,
        command: { ...command, email: "different@example.com" },
        execute,
        database: database as unknown as D1DatabaseBinding,
      }),
    ).rejects.toMatchObject({ code: "key_conflict" });
  });

  it("blocks a retry while an ambiguous mutation remains in progress", async () => {
    const request = new Request(
      "https://foundry.example/api/foundry-cms/members",
      {
        method: "POST",
        headers: { "idempotency-key": "mutation-ambiguous-key" },
      },
    );
    const command = { action: "claim_invitation" };
    let executions = 0;
    const execute = async (): Promise<Response> => {
      executions += 1;
      throw new Error("response lost");
    };

    await expect(
      executeIdempotentHumanMutation({
        request,
        identity: owner,
        command,
        execute,
        database: database as unknown as D1DatabaseBinding,
      }),
    ).rejects.toThrow("response lost");
    await expect(
      executeIdempotentHumanMutation({
        request,
        identity: owner,
        command,
        execute,
        database: database as unknown as D1DatabaseBinding,
      }),
    ).rejects.toMatchObject({ code: "in_progress" });
    expect(executions).toBe(1);
  });

  it("releases a receipt when authorization fails before command dispatch", async () => {
    const request = new Request(
      "https://foundry.example/api/foundry-cms/members",
      {
        method: "POST",
        headers: { "idempotency-key": "mutation-not-started-key" },
      },
    );
    const command = { action: "reconcile_access" };
    let executions = 0;

    await expect(
      executeIdempotentHumanMutation({
        request,
        identity: owner,
        command,
        execute: async () => {
          executions += 1;
          throw new HumanMutationExecutionNotStartedError(
            new Error("D1 read unavailable"),
          );
        },
        database: database as unknown as D1DatabaseBinding,
      }),
    ).rejects.toThrow("D1 read unavailable");

    const retry = await executeIdempotentHumanMutation({
      request,
      identity: owner,
      command,
      execute: async () => {
        executions += 1;
        return Response.json({ synchronized: true });
      },
      database: database as unknown as D1DatabaseBinding,
    });

    expect(retry.status).toBe(200);
    expect(executions).toBe(2);
  });

  it("releases a receipt when a completed operation is explicitly resumable", async () => {
    const request = new Request(
      "https://foundry.example/api/foundry-cms/forms",
      {
        method: "POST",
        headers: { "idempotency-key": "mutation-resumable-key" },
      },
    );
    const command = { action: "restore_backup", backupId: "backup-48" };
    let executions = 0;

    await expect(
      executeIdempotentHumanMutation({
        request,
        identity: owner,
        command,
        execute: async () => {
          executions += 1;
          throw new HumanMutationExecutionResumableError(
            new Error("verification mirror pending"),
          );
        },
        database: database as unknown as D1DatabaseBinding,
      }),
    ).rejects.toThrow("verification mirror pending");

    const retry = await executeIdempotentHumanMutation({
      request,
      identity: owner,
      command,
      execute: async () => {
        executions += 1;
        return Response.json({ verified: true });
      },
      database: database as unknown as D1DatabaseBinding,
    });
    expect(retry.status).toBe(200);
    expect(executions).toBe(2);
  });

  it("persists invitation, activation and immediate suspension through the application seam", async () => {
    let nextId = 0;
    const application = createHumanAccessApplication({
      siteId,
      store: createD1HumanAccessStore(
        database as unknown as D1DatabaseBinding,
      ),
      eligibilitySynchronizer: {
        async replaceExactEmailEligibility() {},
      },
      clock: () => now,
      createId: (kind) => `${kind}-${++nextId}`,
    });

    await application.commands.invite({
      actor: owner,
      email: editor.email,
      role: "editor",
    });
    const membership = await application.commands.activateInvitation({
      actor: editor,
    });

    await expect(
      application.queries.requireCapability({
        actor: editor,
        capability: "content.write",
      }),
    ).resolves.toEqual(membership);

    await application.commands.changeStatus({
      actor: owner,
      membershipId: membership.id,
      status: "suspended",
    });

    await expect(
      application.queries.requireCapability({
        actor: editor,
        capability: "dashboard.view",
      }),
    ).rejects.toEqual(new AccessDeniedError("membership_not_active"));
  });

  it("atomically rejects an invitation for a current membership email", async () => {
    const application = createHumanAccessApplication({
      siteId,
      store: createD1HumanAccessStore(
        database as unknown as D1DatabaseBinding,
      ),
      eligibilitySynchronizer: {
        async replaceExactEmailEligibility() {},
      },
      clock: () => now,
      createId: (kind) => `${kind}-current-email`,
    });

    await expect(
      application.commands.invite({
        actor: owner,
        email: owner.email,
        role: "editor",
      }),
    ).rejects.toEqual(
      new AccessDeniedError("membership_email_ambiguous"),
    );
    await expect(
      database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM human_invitations) AS invitations,
             (SELECT COUNT(*) FROM human_access_sync_outbox) AS outbox,
             (SELECT COUNT(*) FROM human_access_audit_events) AS audit`,
        )
        .first<{
          invitations: number;
          outbox: number;
          audit: number;
        }>(),
    ).resolves.toEqual({ invitations: 0, outbox: 0, audit: 0 });
  });

  it("allows a revoked email to be invited and claimed as a new user", async () => {
    await database.batch([
      database
        .prepare(
          "INSERT INTO human_users (id, email, created_at) VALUES (?1, ?2, ?3)",
        )
        .bind("user-revoked", editor.email, now.toISOString()),
      database
        .prepare(
          `INSERT INTO human_external_identities (
             site_id, issuer, subject, user_id, created_at
           ) VALUES (?1, ?2, ?3, ?4, ?5)`,
        )
        .bind(
          siteId,
          owner.binding.issuer,
          editor.binding.subject,
          "user-revoked",
          now.toISOString(),
        ),
      database
        .prepare(
          `INSERT INTO human_memberships (
             id, site_id, user_id, email, identity_issuer, identity_subject,
             role, status, created_at, updated_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'editor', 'revoked', ?7, ?7)`,
        )
        .bind(
          "membership-revoked",
          siteId,
          "user-revoked",
          editor.email,
          editor.binding.issuer,
          editor.binding.subject,
          now.toISOString(),
        ),
    ]);
    let nextId = 0;
    const application = createHumanAccessApplication({
      siteId,
      store: createD1HumanAccessStore(
        database as unknown as D1DatabaseBinding,
      ),
      eligibilitySynchronizer: {
        async replaceExactEmailEligibility() {},
      },
      clock: () => now,
      createId: (kind) => `${kind}-replacement-${++nextId}`,
    });

    await application.commands.invite({
      actor: owner,
      email: editor.email,
      role: "editor",
    });
    const replacement =
      await application.commands.activateInvitation({ actor: editor });
    expect(replacement).toMatchObject({
      email: editor.email,
      identityBinding: editor.binding,
      status: "active",
    });
    const editorHistory = (
      await application.queries.listMembers({ actor: owner })
    ).filter((membership) => membership.email === editor.email);
    expect(editorHistory).toHaveLength(2);
    expect(editorHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "membership-revoked",
          identityBinding: editor.binding,
          status: "revoked",
        }),
        expect.objectContaining({
          id: replacement.id,
          identityBinding: editor.binding,
          status: "active",
        }),
      ]),
    );
    await expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM human_access_audit_events
           WHERE event_type = 'identity.rebound'`,
        )
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 1 });
  });

  it("rejects an invitation claim when its email already has a membership", async () => {
    await database
      .prepare(
        `INSERT INTO human_invitations (
           id, site_id, email, role, status, expires_at,
           invited_by_membership_id, created_at
         ) VALUES (?1, ?2, ?3, 'editor', 'pending_acceptance', ?4, ?5, ?6)`,
      )
      .bind(
        "invitation-duplicate",
        siteId,
        owner.email,
        "2026-08-03T04:00:00.000Z",
        "membership-owner",
        now.toISOString(),
      )
      .run();
    const application = createHumanAccessApplication({
      siteId,
      store: createD1HumanAccessStore(
        database as unknown as D1DatabaseBinding,
      ),
      eligibilitySynchronizer: {
        async replaceExactEmailEligibility() {},
      },
      clock: () => now,
      createId: (kind) => `${kind}-duplicate`,
    });

    await expect(
      application.commands.activateInvitation({
        actor: {
          binding: {
            issuer: owner.binding.issuer,
            subject: "duplicate-owner-subject",
          },
          email: owner.email,
          nonce: "duplicate-owner-nonce",
        },
      }),
    ).rejects.toEqual(
      new AccessDeniedError("invitation_not_claimable"),
    );
  });

  it("does not create an orphan user when the identity is already active", async () => {
    await database
      .prepare(
        `INSERT INTO human_invitations (
           id, site_id, email, role, status, expires_at,
           invited_by_membership_id, created_at
         ) VALUES (?1, ?2, ?3, 'editor', 'pending_acceptance', ?4, ?5, ?6)`,
      )
      .bind(
        "invitation-bound-identity",
        siteId,
        editor.email,
        "2026-08-03T04:00:00.000Z",
        "membership-owner",
        now.toISOString(),
      )
      .run();
    const application = createHumanAccessApplication({
      siteId,
      store: createD1HumanAccessStore(
        database as unknown as D1DatabaseBinding,
      ),
      eligibilitySynchronizer: {
        async replaceExactEmailEligibility() {},
      },
      clock: () => now,
      createId: (kind) => `${kind}-bound-identity`,
    });

    await expect(
      application.commands.activateInvitation({
        actor: {
          ...owner,
          email: editor.email,
        },
      }),
    ).rejects.toEqual(
      new AccessDeniedError("invitation_not_claimable"),
    );
    await expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM human_users")
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 1 });
  });

  it("chunks large outbox updates within the D1 binding limit", async () => {
    const operationIds = Array.from({ length: 99 }, (_, index) =>
      createEligibilitySyncOperationId(`bulk-operation-${index}`),
    );
    await database.batch(
      operationIds.map((operationId) =>
        database
          .prepare(
            `INSERT INTO human_access_sync_outbox (
               id, site_id, status, next_attempt_at, created_at
             ) VALUES (?1, ?2, 'pending', ?3, ?3)`,
          )
          .bind(operationId, siteId, now.toISOString()),
      ),
    );
    const store = createD1HumanAccessStore(
      database as unknown as D1DatabaseBinding,
    );

    await store.recordEligibilitySyncFailure({
      siteId,
      operationIds,
      now: now.toISOString(),
    });
    await store.markEligibilitySynchronized({
      siteId,
      operationIds,
      now: now.toISOString(),
    });

    await expect(
      database
        .prepare(
          `SELECT
             COUNT(*) AS count,
             SUM(attempts) AS attempts
           FROM human_access_sync_outbox
           WHERE status = 'completed'`,
        )
        .first<{ count: number; attempts: number }>(),
    ).resolves.toEqual({ count: 99, attempts: 99 });
  });

  it("does not return an expired invitation as claimable", async () => {
    await database
      .prepare(
        `INSERT INTO human_invitations (
           id, site_id, email, role, status, expires_at,
           invited_by_membership_id, created_at
         ) VALUES (?1, ?2, ?3, 'editor', 'pending_acceptance', ?4, ?5, ?6)`,
      )
      .bind(
        "invitation-expired",
        siteId,
        editor.email,
        "2026-07-27T03:59:59.000Z",
        "membership-owner",
        "2026-07-20T04:00:00.000Z",
      )
      .run();

    await expect(
      createD1HumanAccessStore(
        database as unknown as D1DatabaseBinding,
      ).findClaimableInvitation({
        siteId,
        email: editor.email,
        now: now.toISOString(),
      }),
    ).resolves.toBeNull();
  });
});
