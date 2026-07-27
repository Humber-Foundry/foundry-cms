import type {
  ConsentEvidence,
  SensitiveSubscriberAccessEvent,
  Subscriber,
  SubscriberEvent,
  SubscriberEventActor,
  SubscriberLedgerStore,
  SubscriberState,
} from "@foundry/application";
import {
  createHumanMembershipId,
  createSubscriberEventId,
  createSubscriberId,
  ErasedSubscriberError,
  SubscriberAlreadyExistsError,
  subscriberStatesOverriddenBySuppression,
} from "@foundry/application";
import type { SiteId } from "@foundry/site-definition";

import type { D1DatabaseBinding } from "./d1-human-access-store";

type SubscriberRow = {
  id: string;
  site_id: string;
  identity_key: string;
  email: string | null;
  state: SubscriberState;
  created_at: string;
  updated_at: string;
};

type EventRow = {
  id: string;
  site_id: string;
  subscriber_id: string;
  event_type: SubscriberEvent["type"];
  occurred_at: string;
  recorded_at: string;
  actor_type: SubscriberEventActor["type"];
  actor_membership_id: string | null;
  provider: string | null;
  provider_event_id: string | null;
  evidence_json: string | null;
};

type SnapshotRow =
  | (SubscriberRow & { record_type: "subscriber" })
  | (EventRow & { record_type: "event" });

function toSubscriber(row: SubscriberRow): Subscriber {
  return {
    id: createSubscriberId(row.id),
    siteId: row.site_id as SiteId,
    identityKey: row.identity_key,
    email: row.email,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEvent(row: EventRow): SubscriberEvent {
  const actor: SubscriberEventActor =
    row.actor_type === "human"
      ? {
          type: "human",
          membershipId: createHumanMembershipId(
            row.actor_membership_id!,
          ),
        }
      : {
          type: "provider",
          provider: row.provider!,
          providerEventId: row.provider_event_id!,
        };
  const base = {
    id: createSubscriberEventId(row.id),
    siteId: row.site_id as SiteId,
    subscriberId: createSubscriberId(row.subscriber_id),
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    actor,
  };
  if (
    row.event_type === "consent_recorded" ||
    row.event_type === "resubscribed"
  ) {
    return {
      ...base,
      type: row.event_type,
      evidence: JSON.parse(row.evidence_json!) as ConsentEvidence,
    };
  }
  return { ...base, type: row.event_type, evidence: null };
}

const subscriberProjection = `
  SELECT
    id, site_id, identity_key, email, state, created_at, updated_at
  FROM subscribers
`;
function eventStatement(
  database: D1DatabaseBinding,
  event: SubscriberEvent,
) {
  const humanActor =
    event.actor.type === "human" ? event.actor.membershipId : null;
  const provider =
    event.actor.type === "provider" ? event.actor.provider : null;
  const providerEventId =
    event.actor.type === "provider" ? event.actor.providerEventId : null;
  return database
    .prepare(
      `INSERT INTO subscriber_ledger_events (
         id, site_id, subscriber_id, event_type, occurred_at, recorded_at,
         actor_type, actor_membership_id, provider, provider_event_id,
         evidence_json
       )
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
       WHERE EXISTS (
         SELECT 1 FROM subscribers
         WHERE id = ?3
           AND site_id = ?2
           AND (?12 <> 'resubscribed' OR state <> 'erased')
       )
       ON CONFLICT DO NOTHING`,
    )
    .bind(
      event.id,
      event.siteId,
      event.subscriberId,
      event.type,
      event.occurredAt,
      event.recordedAt,
      event.actor.type,
      humanActor,
      provider,
      providerEventId,
      event.evidence === null ? null : JSON.stringify(event.evidence),
      event.type,
    );
}

export function createD1SubscriberLedgerStore(
  database: D1DatabaseBinding,
): SubscriberLedgerStore {
  async function findSubscriberById(id: string) {
    const row = await database
      .prepare(`${subscriberProjection} WHERE id = ?1`)
      .bind(id)
      .first<SubscriberRow>();
    return row === null ? null : toSubscriber(row);
  }

  return {
    async findByIdentityKey({ siteId, identityKey }) {
      const row = await database
        .prepare(
          `${subscriberProjection}
           WHERE site_id = ?1 AND identity_key = ?2`,
        )
        .bind(siteId, identityKey)
        .first<SubscriberRow>();
      return row === null ? null : toSubscriber(row);
    },
    async createWithEvent({ subscriber, event }) {
      const provider =
        event.actor.type === "provider" ? event.actor.provider : null;
      const providerEventId =
        event.actor.type === "provider"
          ? event.actor.providerEventId
          : null;
      const results = await database.batch([
        database
          .prepare(
            `INSERT INTO subscribers (
               id, site_id, identity_key, email, state, created_at, updated_at
             )
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?6
             WHERE (
               ?7 IS NULL
               OR NOT EXISTS (
                 SELECT 1 FROM subscriber_ledger_events
                 WHERE site_id = ?2
                   AND provider = ?7
                   AND provider_event_id = ?8
               )
             )
             ON CONFLICT (site_id, identity_key) DO NOTHING`,
          )
          .bind(
            subscriber.id,
            subscriber.siteId,
            subscriber.identityKey,
            subscriber.email,
            subscriber.state,
            subscriber.createdAt,
            provider,
            providerEventId,
          ),
        eventStatement(database, event),
      ]);
      if ((results[0]?.meta.changes ?? 0) < 1) {
        if (event.actor.type === "human") {
          throw new SubscriberAlreadyExistsError();
        }
        throw new Error("provider_event_conflict");
      }
      const saved = await findSubscriberById(subscriber.id);
      if (saved === null) {
        throw new Error("subscriber_write_failed");
      }
      return saved;
    },
    async appendEvent({ subscriber, event }) {
      if (event.type === "consent_recorded") {
        throw new Error("initial_consent_must_create_subscriber");
      }
      const update =
        event.type === "resubscribed"
          ? database
              .prepare(
                `UPDATE subscribers
                 SET email = ?1, state = 'active', updated_at = ?2
                 WHERE id = ?3
                   AND site_id = ?4
                   AND state <> 'erased'
                   AND EXISTS (
                     SELECT 1 FROM subscriber_ledger_events
                     WHERE id = ?5
                       AND subscriber_id = ?3
                       AND site_id = ?4
                   )`,
              )
              .bind(
                subscriber.email,
                subscriber.updatedAt,
                subscriber.id,
                subscriber.siteId,
                event.id,
              )
          : event.type === "erased"
            ? database
                .prepare(
                  `UPDATE subscribers
                   SET email = NULL, state = 'erased', updated_at = ?1
                   WHERE id = ?2
                     AND site_id = ?3
                     AND EXISTS (
                       SELECT 1 FROM subscriber_ledger_events
                       WHERE id = ?4
                         AND subscriber_id = ?2
                         AND site_id = ?3
                     )`,
                )
                .bind(
                  subscriber.updatedAt,
                  subscriber.id,
                  subscriber.siteId,
                  event.id,
                )
            : (() => {
                const overridden =
                  subscriberStatesOverriddenBySuppression(event.type);
                const placeholders = overridden
                  .map((_, index) => `?${index + 6}`)
                  .join(", ");
                return database
                  .prepare(
                    `UPDATE subscribers
                     SET
                       state = CASE
                         WHEN state IN (${placeholders}) THEN ?1
                         ELSE state
                       END,
                       updated_at = ?2
                     WHERE id = ?3
                       AND site_id = ?4
                       AND EXISTS (
                         SELECT 1 FROM subscriber_ledger_events
                         WHERE id = ?5
                           AND subscriber_id = ?3
                           AND site_id = ?4
                       )`,
                  )
                  .bind(
                    event.type,
                    subscriber.updatedAt,
                    subscriber.id,
                    subscriber.siteId,
                    event.id,
                    ...overridden,
                  );
              })();
      await database.batch([eventStatement(database, event), update]);
      const saved = await findSubscriberById(subscriber.id);
      if (saved === null) {
        throw new Error("subscriber_not_found");
      }
      if (event.type === "resubscribed" && saved.state === "erased") {
        throw new ErasedSubscriberError();
      }
      return saved;
    },
    async listSubscribers(siteId) {
      const rows = await database
        .prepare(
          `${subscriberProjection}
           WHERE site_id = ?1
           ORDER BY COALESCE(email, identity_key), id`,
        )
        .bind(siteId)
        .all<SubscriberRow>();
      return rows.results.map(toSubscriber);
    },
    async readSnapshot(siteId) {
      const rows = await database
        .prepare(
          `SELECT
             'subscriber' AS record_type,
             id, site_id, identity_key, email, state, created_at, updated_at,
             NULL AS subscriber_id, NULL AS event_type,
             NULL AS occurred_at, NULL AS recorded_at, NULL AS actor_type,
             NULL AS actor_membership_id, NULL AS provider,
             NULL AS provider_event_id, NULL AS evidence_json
           FROM subscribers
           WHERE site_id = ?1
           UNION ALL
           SELECT
             'event' AS record_type,
             id, site_id, NULL AS identity_key, NULL AS email, NULL AS state,
             NULL AS created_at, NULL AS updated_at,
             subscriber_id, event_type, occurred_at, recorded_at, actor_type,
             actor_membership_id, provider, provider_event_id, evidence_json
           FROM subscriber_ledger_events
           WHERE site_id = ?1`,
        )
        .bind(siteId)
        .all<SnapshotRow>();
      return {
        subscribers: rows.results
          .filter(
            (row): row is SubscriberRow & { record_type: "subscriber" } =>
              row.record_type === "subscriber",
          )
          .map(toSubscriber)
          .sort((left, right) =>
            (left.email ?? left.identityKey).localeCompare(
              right.email ?? right.identityKey,
            ),
          ),
        events: rows.results
          .filter(
            (row): row is EventRow & { record_type: "event" } =>
              row.record_type === "event",
          )
          .map(toEvent)
          .sort(
            (left, right) =>
              left.recordedAt.localeCompare(right.recordedAt) ||
              left.id.localeCompare(right.id),
          ),
      };
    },
    async recordSensitiveAccess(event: SensitiveSubscriberAccessEvent) {
      await database
        .prepare(
          `INSERT INTO subscriber_sensitive_access_audit (
             id, site_id, actor_membership_id, action, occurred_at
           ) VALUES (?1, ?2, ?3, ?4, ?5)`,
        )
        .bind(
          event.id,
          event.siteId,
          event.actorMembershipId,
          event.action,
          event.occurredAt,
        )
        .run();
    },
  };
}
