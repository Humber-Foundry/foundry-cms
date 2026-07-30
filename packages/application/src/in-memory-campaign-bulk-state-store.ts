import { sha256CanonicalJson } from "./deterministic-hash";
import type { CampaignId, CampaignRevisionId } from "./campaign";
import {
  campaignDeliveryAttemptedEventTypes,
  CampaignBulkDeliveryError,
  type CampaignBulkAuthorization,
  type CampaignBulkSchedule,
  type CampaignBulkSendOperation,
  type CampaignBulkStateStore,
  type VerifiedCampaignDeliveryEvent,
} from "./campaign-bulk-delivery";

type Receipt<T> = Readonly<{ inputHash: string; value: T }>;

export function createInMemoryCampaignBulkStateStore({
  currentRevision,
  activeOwners,
  activeSubscribers,
}: {
  currentRevision(campaignId: CampaignId): CampaignRevisionId;
  activeOwners: Set<string>;
  activeSubscribers: Set<string>;
}): CampaignBulkStateStore {
  const authorizations = new Map<string, CampaignBulkAuthorization>();
  const schedules = new Map<string, CampaignBulkSchedule>();
  const operations = new Map<string, CampaignBulkSendOperation>();
  const authorizationReceipts = new Map<
    string,
    Receipt<CampaignBulkAuthorization>
  >();
  const scheduleReceipts = new Map<string, Receipt<CampaignBulkSchedule>>();
  const sendReceipts = new Map<string, Receipt<CampaignBulkSendOperation>>();
  const events = new Map<string, VerifiedCampaignDeliveryEvent>();

  function replay<T>(
    receipts: Map<string, Receipt<T>>,
    key: string,
    inputHash: string,
  ) {
    const prior = receipts.get(key);
    if (prior === undefined) return null;
    if (prior.inputHash !== inputHash) {
      throw new CampaignBulkDeliveryError("bulk_idempotency_key_reused");
    }
    return Object.freeze({ value: prior.value, replayed: true });
  }

  return Object.freeze({
    async recordAudit() {},
    async findAuthorizationByRequest({ ownerActorId, requestId }) {
      return authorizationReceipts.get(`${ownerActorId}:${requestId}`) ?? null;
    },
    async findAuthorization({ authorizationId }) {
      return authorizations.get(authorizationId) ?? null;
    },
    async saveAuthorization({ requestId, inputHash, authorization }) {
      const receiptKey = `${authorization.ownerActorId}:${requestId}`;
      const prior = replay(authorizationReceipts, receiptKey, inputHash);
      if (prior !== null) return prior;
      if (
        currentRevision(authorization.campaignId) !==
          authorization.campaignRevisionId ||
        !activeOwners.has(authorization.ownerActorId)
      ) {
        throw new CampaignBulkDeliveryError("bulk_authorization_stale");
      }
      for (const existing of authorizations.values()) {
        if (
          existing.campaignId === authorization.campaignId &&
          existing.state === "active"
        ) {
          throw new CampaignBulkDeliveryError("bulk_authorization_exists");
        }
      }
      authorizations.set(authorization.id, authorization);
      authorizationReceipts.set(receiptKey, {
        inputHash,
        value: authorization,
      });
      return Object.freeze({ value: authorization, replayed: false });
    },
    async activateSchedule({ requestId, inputHash, schedule }) {
      const prior = replay(scheduleReceipts, requestId, inputHash);
      if (prior !== null) return prior;
      const authority = authorizations.get(schedule.authorizationId);
      if (
        authority === undefined ||
        authority.state !== "active" ||
        authority.campaignId !== schedule.campaignId ||
        authority.ownerActorId !== schedule.activatedBy ||
        currentRevision(schedule.campaignId) !== authority.campaignRevisionId ||
        !activeOwners.has(schedule.activatedBy)
      ) {
        throw new CampaignBulkDeliveryError("bulk_authorization_stale");
      }
      for (const existing of operations.values()) {
        if (existing.campaignId === schedule.campaignId) {
          throw new CampaignBulkDeliveryError("bulk_send_already_exists");
        }
      }
      for (const existing of schedules.values()) {
        if (
          existing.campaignId === schedule.campaignId &&
          existing.state === "active"
        ) {
          schedules.set(
            existing.id,
            Object.freeze({
              ...existing,
              state: "cancelled",
              updatedAt: schedule.createdAt,
            }),
          );
        }
      }
      schedules.set(schedule.id, schedule);
      scheduleReceipts.set(requestId, { inputHash, value: schedule });
      return Object.freeze({ value: schedule, replayed: false });
    },
    async cancelSchedule({ ownerActorId, scheduleId, now }) {
      const schedule = schedules.get(scheduleId);
      if (
        schedule === undefined ||
        schedule.activatedBy !== ownerActorId ||
        schedule.state !== "active" ||
        !activeOwners.has(ownerActorId)
      ) {
        throw new CampaignBulkDeliveryError("bulk_schedule_not_cancellable");
      }
      const cancelled: CampaignBulkSchedule = Object.freeze({
        ...schedule,
        state: "cancelled",
        updatedAt: now,
      });
      schedules.set(scheduleId, cancelled);
      return cancelled;
    },
    async createSendOperation({ requestId, inputHash, operation }) {
      const prior = replay(sendReceipts, requestId, inputHash);
      if (prior !== null) return prior;
      const authority = authorizations.get(operation.authorizationId);
      if (
        authority === undefined ||
        authority.state !== "active" ||
        authority.campaignRevisionId !== operation.campaignRevisionId ||
        currentRevision(operation.campaignId) !==
          operation.campaignRevisionId ||
        !activeOwners.has(authority.ownerActorId)
      ) {
        throw new CampaignBulkDeliveryError("bulk_authorization_stale");
      }
      for (const existing of operations.values()) {
        if (existing.campaignId === operation.campaignId) {
          throw new CampaignBulkDeliveryError("bulk_send_already_exists");
        }
      }
      for (const [scheduleId, schedule] of schedules) {
        if (
          schedule.authorizationId === operation.authorizationId &&
          schedule.state === "active"
        ) {
          schedules.set(
            scheduleId,
            Object.freeze({
              ...schedule,
              state: "cancelled",
              updatedAt: operation.createdAt,
            }),
          );
        }
      }
      operations.set(operation.id, operation);
      sendReceipts.set(requestId, { inputHash, value: operation });
      return Object.freeze({ value: operation, replayed: false });
    },
    async claimDueSchedule({
      now,
      latenessCutoff,
      leaseToken,
      leaseExpiresAt,
      createOperationId,
    }) {
      for (let scanned = 0; scanned < 100; scanned += 1) {
        const due = [...schedules.values()]
          .filter(
            (schedule) =>
              schedule.state === "active" && schedule.executeAtUtc <= now,
          )
          .sort(
            (left, right) =>
              left.executeAtUtc.localeCompare(right.executeAtUtc) ||
              left.id.localeCompare(right.id),
          )[0];
        if (due === undefined) return null;
        const authority = authorizations.get(due.authorizationId);
        if (
          due.executeAtUtc < latenessCutoff ||
          authority === undefined ||
          authority.state !== "active" ||
          currentRevision(due.campaignId) !== authority.campaignRevisionId ||
          !activeOwners.has(authority.ownerActorId)
        ) {
          schedules.set(
            due.id,
            Object.freeze({
              ...due,
              state: due.executeAtUtc < latenessCutoff ? "missed" : "blocked",
              updatedAt: now,
            }),
          );
          continue;
        }
        const operationId = createOperationId();
        const stableSendKey = await sha256CanonicalJson({
          version: "foundry.campaign-bulk-send.v1",
          siteId: due.siteId,
          operationId,
          scheduleId: due.id,
          scheduledInstant: due.executeAtUtc,
        });
        const operation: CampaignBulkSendOperation = Object.freeze({
          id: operationId,
          siteId: due.siteId,
          campaignId: due.campaignId,
          campaignRevisionId: authority.campaignRevisionId,
          authorizationId: authority.id,
          scheduleId: due.id,
          scheduledInstant: due.executeAtUtc,
          stableSendKey,
          state: "preparing",
          attempt: 1,
          leaseToken,
          leaseExpiresAt,
          audienceSnapshot: null,
          sendArtifact: null,
          sendArtifactHash: null,
          sendArtifactCommitSha: null,
          providerCampaignId: null,
          providerMessageId: null,
          providerSendProof: null,
          providerVerification: null,
          detail: null,
          createdAt: now,
          updatedAt: now,
        });
        schedules.set(
          due.id,
          Object.freeze({
            ...due,
            state: "claimed",
            updatedAt: now,
          }),
        );
        operations.set(operation.id, operation);
        return operation;
      }
      return null;
    },
    async findOperation({ operationId }) {
      return operations.get(operationId) ?? null;
    },
    async listReconciliationCandidates({ now, sentReportingCutoff, limit }) {
      return [...operations.values()]
        .filter(
          (operation) =>
            operation.state === "ambiguous" ||
            operation.state === "provider_queued" ||
            ((operation.state === "preparing" ||
              operation.state === "attempting") &&
              (operation.leaseExpiresAt === null ||
                operation.leaseExpiresAt <= now)) ||
            (operation.state === "sent" &&
              operation.updatedAt > sentReportingCutoff),
        )
        .sort(
          (left, right) =>
            left.updatedAt.localeCompare(right.updatedAt) ||
            left.id.localeCompare(right.id),
        )
        .slice(0, limit);
    },
    async claimOperation({
      operationId,
      expectedCampaignRevisionId,
      expectedOwnerActorId,
      now,
      heldLeaseToken,
      leaseToken,
      leaseExpiresAt,
    }) {
      const operation = operations.get(operationId);
      if (operation === undefined) return null;
      const authority = authorizations.get(operation.authorizationId);
      if (
        authority === undefined ||
        authority.state !== "active" ||
        authority.ownerActorId !== expectedOwnerActorId ||
        operation.campaignRevisionId !== expectedCampaignRevisionId ||
        currentRevision(operation.campaignId) !== expectedCampaignRevisionId ||
        !activeOwners.has(expectedOwnerActorId) ||
        // A live lease belongs to whoever holds it, and only a caller that can
        // present its token is that holder.
        (operation.leaseExpiresAt !== null &&
          operation.leaseExpiresAt > now &&
          operation.leaseToken !== heldLeaseToken)
      ) {
        return null;
      }
      if (
        operation.state !== "preparing" &&
        operation.state !== "attempting" &&
        operation.state !== "ambiguous" &&
        operation.state !== "failed" &&
        operation.state !== "blocked"
      ) {
        return null;
      }
      const claimed = Object.freeze({
        ...operation,
        state:
          operation.state === "failed" || operation.state === "blocked"
            ? ("preparing" as const)
            : operation.state,
        attempt: operation.attempt + 1,
        leaseToken,
        leaseExpiresAt,
        updatedAt: now,
      });
      operations.set(operationId, claimed);
      return claimed;
    },
    async saveAudienceSnapshot({
      operation,
      snapshot,
      sendArtifact,
      sendArtifactHash,
      now,
    }) {
      const current = operations.get(operation.id);
      if (
        current?.leaseToken !== operation.leaseToken ||
        current.leaseExpiresAt === null ||
        current.leaseExpiresAt <= now ||
        // Once a provider attempt has opened, the snapshot and artifact it was
        // built from are the immutable record of what was requested.
        (current.providerSendProof !== null &&
          (current.audienceSnapshot?.fingerprint !== snapshot.fingerprint ||
            current.sendArtifactHash !== sendArtifactHash))
      ) {
        return null;
      }
      const saved = Object.freeze({
        ...current,
        audienceSnapshot: snapshot,
        sendArtifact,
        sendArtifactHash,
        // A replacement artifact needs its own commit; the superseded commit
        // stays in Git history untouched.
        sendArtifactCommitSha:
          current.sendArtifactHash === sendArtifactHash
            ? current.sendArtifactCommitSha
            : null,
        updatedAt: now,
      });
      operations.set(operation.id, saved);
      return saved;
    },
    async recordArtifactPublication({ operation, outcome, now }) {
      const current = operations.get(operation.id);
      if (
        current === undefined ||
        current.leaseToken !== operation.leaseToken
      ) {
        throw new CampaignBulkDeliveryError("bulk_execution_lease_lost");
      }
      const recorded = Object.freeze({
        ...current,
        state:
          outcome.outcome === "failed" ? ("blocked" as const) : current.state,
        sendArtifactCommitSha:
          outcome.outcome === "committed"
            ? outcome.commitSha
            : current.sendArtifactCommitSha,
        detail: "code" in outcome ? outcome.code : null,
        leaseToken: outcome.outcome === "committed" ? current.leaseToken : null,
        leaseExpiresAt:
          outcome.outcome === "committed" ? current.leaseExpiresAt : null,
        updatedAt: now,
      });
      operations.set(operation.id, recorded);
      return recorded;
    },
    async releaseLease({ operation, now }) {
      const current = operations.get(operation.id);
      if (
        current === undefined ||
        current.leaseToken !== operation.leaseToken ||
        current.providerSendProof !== null
      ) {
        return;
      }
      operations.set(
        operation.id,
        Object.freeze({
          ...current,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: now,
        }),
      );
    },
    async beginProviderAttempt({
      operation,
      activeSubscriberIds: ids,
      providerCampaignId,
      providerSendProof,
      now,
    }) {
      const current = operations.get(operation.id);
      if (
        current?.leaseToken !== operation.leaseToken ||
        current.leaseExpiresAt === null ||
        current.leaseExpiresAt <= now ||
        current.audienceSnapshot === null ||
        current.sendArtifactCommitSha === null ||
        (current.providerCampaignId !== null &&
          current.providerCampaignId !== providerCampaignId) ||
        (current.providerSendProof !== null &&
          current.providerSendProof !== providerSendProof) ||
        current.audienceSnapshot.subscriberIds.length !== ids.length ||
        ids.some(
          (id, index) =>
            id !== current.audienceSnapshot!.subscriberIds[index] ||
            !activeSubscribers.has(id),
        )
      ) {
        return null;
      }
      const attempting: CampaignBulkSendOperation = Object.freeze({
        ...current,
        state: "attempting",
        providerCampaignId,
        providerSendProof,
        updatedAt: now,
      });
      operations.set(operation.id, attempting);
      return attempting;
    },
    async recordProviderOutcome({ operation, outcome, now }) {
      const current = operations.get(operation.id);
      if (
        current === undefined ||
        current.leaseToken !== operation.leaseToken
      ) {
        throw new CampaignBulkDeliveryError("bulk_execution_lease_lost");
      }
      const state =
        outcome.outcome === "accepted"
          ? "provider_queued"
          : outcome.outcome === "verified"
            ? current.state === "provider_queued"
              ? "provider_queued"
              : "ambiguous"
            : outcome.outcome === "ambiguous"
              ? "ambiguous"
              : "failed";
      if (
        outcome.outcome === "verified" &&
        (outcome.providerMessageIds.length === 0 ||
          outcome.providerMessageIds.some(
            (id) => id.trim() === "" || id.length > 512,
          ) ||
          new Set(outcome.providerMessageIds).size !==
            outcome.providerMessageIds.length)
      ) {
        throw new CampaignBulkDeliveryError(
          "bulk_provider_evidence_invalid",
        );
      }
      if (
        outcome.outcome === "verified" &&
        current.providerVerification !== null &&
        JSON.stringify(current.providerVerification.providerMessageIds) !==
          JSON.stringify([...new Set(outcome.providerMessageIds)].sort())
      ) {
        throw new CampaignBulkDeliveryError("bulk_provider_evidence_invalid");
      }
      const recorded: CampaignBulkSendOperation = Object.freeze({
        ...current,
        state,
        providerCampaignId:
          "providerCampaignId" in outcome
            ? outcome.providerCampaignId
            : current.providerCampaignId,
        providerMessageId:
          outcome.outcome === "accepted"
            ? outcome.providerMessageId
            : outcome.outcome === "verified" &&
                outcome.providerMessageIds.length === 1
              ? outcome.providerMessageIds[0]!
              : current.providerMessageId,
        providerVerification:
          outcome.outcome === "verified"
            ? (current.providerVerification ??
              Object.freeze({
                providerMessageIds: Object.freeze(
                  [...new Set(outcome.providerMessageIds)].sort(),
                ),
                verifiedAt: now,
              }))
            : current.providerVerification,
        detail: "code" in outcome ? outcome.code : null,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: now,
      });
      operations.set(operation.id, recorded);
      return recorded;
    },
    async recordEvent(event) {
      const prior = events.get(event.eventId);
      if (prior !== undefined) {
        return prior.payloadFingerprint === event.payloadFingerprint
          ? "duplicate"
          : "conflict";
      }
      const operation = operations.get(event.operationId);
      if (
        operation === undefined ||
        operation.providerCampaignId !== event.providerCampaignId ||
        operation.audienceSnapshot === null ||
        (event.source === "webhook" &&
          operation.providerSendProof !== event.providerSendProof) ||
        (event.source === "poll" && event.providerSendProof !== null) ||
        !operation.audienceSnapshot.recipients.some(
          ({ identityKey }) => identityKey === event.recipientIdentityKey,
        )
      ) {
        throw new CampaignBulkDeliveryError("bulk_delivery_event_unmatched");
      }
      events.set(event.eventId, event);
      return "recorded";
    },
    async confirmProviderAcceptance({
      operationId,
      providerCampaignId,
      providerMessageIds,
      now,
    }) {
      const operation = operations.get(operationId);
      if (
        operation === undefined ||
        operation.providerCampaignId !== providerCampaignId ||
        operation.audienceSnapshot === null ||
        operation.providerSendProof === null ||
        operation.providerVerification === null
      ) {
        return null;
      }
      const normalizedProviderMessageIds = [
        ...new Set(providerMessageIds),
      ].sort();
      if (
        JSON.stringify(normalizedProviderMessageIds) !==
        JSON.stringify(operation.providerVerification.providerMessageIds)
      ) {
        return null;
      }
      const expectedIdentities = new Set(
        operation.audienceSnapshot.recipients.map(
          ({ identityKey }) => identityKey,
        ),
      );
      const expectedMessages = new Set(normalizedProviderMessageIds);
      const authenticated = [...events.values()].filter(
        (event) =>
          event.operationId === operationId &&
          event.source === "webhook" &&
          event.providerCampaignId === providerCampaignId &&
          event.providerSendProof === operation.providerSendProof &&
          // Only an event proving the provider attempted the message can be
          // evidence that this recipient was reached.
          campaignDeliveryAttemptedEventTypes.has(event.type) &&
          event.providerMessageId !== null &&
          expectedMessages.has(event.providerMessageId),
      );
      const observedIdentities = new Set(
        authenticated.map(({ recipientIdentityKey }) => recipientIdentityKey),
      );
      const observedMessages = new Set(
        authenticated.map(({ providerMessageId }) => providerMessageId!),
      );
      const unexpectedAuthenticated = [...events.values()].some(
        (event) =>
          event.operationId === operationId &&
          event.source === "webhook" &&
          event.providerCampaignId === providerCampaignId &&
          event.providerSendProof === operation.providerSendProof &&
          campaignDeliveryAttemptedEventTypes.has(event.type) &&
          (event.providerMessageId === null ||
            !expectedMessages.has(event.providerMessageId)),
      );
      if (
        unexpectedAuthenticated ||
        observedIdentities.size !== expectedIdentities.size ||
        [...expectedIdentities].some(
          (identity) => !observedIdentities.has(identity),
        ) ||
        observedMessages.size !== expectedMessages.size ||
        [...expectedMessages].some((message) => !observedMessages.has(message))
      ) {
        return null;
      }
      const sent = Object.freeze({
        ...operation,
        state: "sent" as const,
        updatedAt: now,
      });
      operations.set(operationId, sent);
      const authority = authorizations.get(operation.authorizationId);
      if (authority !== undefined && authority.state === "active") {
        authorizations.set(
          authority.id,
          Object.freeze({
            ...authority,
            state: "consumed",
          }),
        );
      }
      if (operation.scheduleId !== null) {
        const schedule = schedules.get(operation.scheduleId);
        if (schedule !== undefined && schedule.state === "claimed") {
          schedules.set(
            schedule.id,
            Object.freeze({
              ...schedule,
              state: "completed",
              updatedAt: now,
            }),
          );
        }
      }
      return sent;
    },
  });
}
