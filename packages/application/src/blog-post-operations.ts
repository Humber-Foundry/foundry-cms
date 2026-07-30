import type { BlogPostId, SiteId } from "@foundry/site-definition";

import type {
  ContentActorId,
  ContentWorkspaceId,
} from "./content-revisions";
import type {
  ContentApprovalId,
} from "./content-publication";
import type { McpLinkedPublicationAudit } from "./mcp-read";

export type BlogPostCollectionState = "active" | "archiving" | "archived";

export type BlogPostOperationalState = Readonly<{
  siteId: SiteId | string;
  postId: BlogPostId | string;
  workspaceId: ContentWorkspaceId;
  contentRevision: number;
  postRevision: number;
  postRevisionId: string;
  collectionState: BlogPostCollectionState;
  workflowState:
    | "editing"
    | "approval_required"
    | "approved"
    | "scheduled"
    | "executing"
    | "failed"
    | "superseded";
  liveRevisionId: string | null;
  version: number;
}>;

export type BlogPostScheduleState =
  | "active"
  | "claimed"
  | "cancelled"
  | "blocked"
  | "failed"
  | "unknown"
  | "completed";

export type ResolvedPostPublicationTime = Readonly<{
  localDateTime: string;
  ianaTimeZone: string;
  utcOffsetChoice: string;
  executeAtUtc: string;
  timeZoneDatabaseVersion: string;
}>;

export type BlogPostSchedule = Readonly<{
  id: string;
  siteId: SiteId | string;
  postId: BlogPostId | string;
  workspaceId: ContentWorkspaceId;
  contentRevision: number;
  postRevisionId: string;
  approvalId: ContentApprovalId;
  approvalFingerprint: string;
  authorityPostRevisionId: string;
  authorityVersion: number;
  localDateTime: string;
  ianaTimeZone: string;
  utcOffsetChoice: string;
  executeAtUtc: string;
  timeZoneDatabaseVersion: string;
  createdBy: ContentActorId;
  activatedBy: ContentActorId;
  activationAuditId: string;
  activatedAt: string;
  state: BlogPostScheduleState;
  detail: string | null;
}>;

export type BlogPostScheduleProposal = Readonly<{
  id: string;
  siteId: SiteId | string;
  postId: BlogPostId | string;
  workspaceId: ContentWorkspaceId;
  contentRevision: number;
  postRevisionId: string;
  authorityVersion: number;
  localDateTime: string;
  ianaTimeZone: string;
  utcOffsetChoice: string;
  executeAtUtc: string;
  timeZoneDatabaseVersion: string;
  createdBy: ContentActorId;
  proposalAuditId: string;
  createdAt: string;
}>;

export type BlogPostScheduleExecution = Readonly<{
  executionId: string;
  scheduleId: string;
  publicationIdempotencyKey: string;
  scheduledInstant: string;
  attempt: number;
  attemptActorId: string;
  attemptRequestId: string;
  leaseExpiresAt: string;
  state: "claimed" | "blocked" | "failed" | "unknown" | "completed";
  detail: string | null;
  claimedAt: string;
  updatedAt: string;
}>;

export type BlogPostScheduleExecutionLease = Readonly<{
  siteId: SiteId | string;
  postId: BlogPostId | string;
  execution: BlogPostScheduleExecution;
  leaseToken: string;
  replayed?: boolean;
}>;

export type BlogPostScheduleClaim = Readonly<{
  execution: BlogPostScheduleExecution;
  lease: BlogPostScheduleExecutionLease | null;
}>;

export type McpBlogScheduleAuthority = Readonly<{
  kind: "mcp";
  connectionId: string;
  actorId: string;
  operation: "foundry.publication.schedule";
  requiredScopes: ReadonlyArray<string>;
  audit?: McpLinkedPublicationAudit;
}>;

export type BlogPostArchiveResult = BlogPostOperationalState &
  Readonly<{
    selectedPostRevisionId: string;
    withdrawalRequired: boolean;
  }>;

export type RestoredBlogPostDraft = BlogPostOperationalState &
  Readonly<{
    targetVisibility: "unpublished";
    sourcePostRevisionId: string;
  }>;

export type BlogPostApprovalEvidence = Readonly<{
  id: ContentApprovalId;
  siteId: SiteId | string;
  workspaceId: ContentWorkspaceId;
  contentRevision: number;
  fingerprint: string;
  postArtifacts: ReadonlyArray<
    Readonly<{ postId: BlogPostId | string; postRevisionId: string }>
  >;
  invalidatedAt: string | null;
}>;

export class BlogPostOperationError extends Error {
  constructor(
    readonly code: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(code);
    this.name = "BlogPostOperationError";
  }
}

export type BlogPostOperationsStore = Readonly<{
  findPost(
    siteId: SiteId | string,
    postId: BlogPostId | string,
  ): Promise<BlogPostOperationalState | null>;
  findApproval(
    approvalId: ContentApprovalId,
  ): Promise<BlogPostApprovalEvidence | null>;
  hasCurrentApprovalAuthority(input: {
    siteId: SiteId | string;
    postId: BlogPostId | string;
    approvalId: ContentApprovalId;
    workspaceId: ContentWorkspaceId;
    contentRevision: number;
    postRevisionId: string;
    authorityPostRevisionId: string;
    approvalFingerprint: string;
    authorityVersion: number;
  }): Promise<boolean>;
  saveScheduleProposal(
    proposal: BlogPostScheduleProposal,
    idempotencyKey: string,
  ): Promise<BlogPostScheduleProposal>;
  findScheduleProposalByRequest(input: {
    siteId: SiteId | string;
    postId: BlogPostId | string;
    idempotencyKey: string;
  }): Promise<BlogPostScheduleProposal | null>;
  hasHumanContentAuthority(input: {
    siteId: SiteId | string;
    actorId: ContentActorId;
  }): Promise<boolean>;
  hasScheduleProposalAuthority(input: {
    siteId: SiteId | string;
    postId: BlogPostId | string;
    actorId: ContentActorId;
  }): Promise<boolean>;
  hasMcpScheduleAuthority(input: {
    siteId: SiteId | string;
    connectionId: string;
    actorId: string;
    requiredScopes: ReadonlyArray<string>;
  }): Promise<boolean>;
  findMcpScheduleAuthority(
    scheduleId: string,
  ): Promise<McpBlogScheduleAuthority | null>;
  findSchedulablePostForApproval(input: {
    siteId: SiteId | string;
    workspaceId: ContentWorkspaceId;
    contentRevision: number;
    approvalId: ContentApprovalId;
  }): Promise<BlogPostOperationalState | null>;
  saveSchedule(
    schedule: BlogPostSchedule,
    idempotencyKey: string,
    authority?: McpBlogScheduleAuthority,
  ): Promise<BlogPostSchedule>;
  findScheduleByRequest(input: {
    siteId: SiteId | string;
    postId: BlogPostId | string;
    idempotencyKey: string;
  }): Promise<BlogPostSchedule | null>;
  findScheduleByWorkspaceRequest(input: {
    siteId: SiteId | string;
    workspaceId: ContentWorkspaceId;
    idempotencyKey: string;
  }): Promise<BlogPostSchedule | null>;
  findSchedule(scheduleId: string): Promise<BlogPostSchedule | null>;
  findScheduleCancellationByRequest(input: {
    siteId: SiteId | string;
    requestId: string;
  }): Promise<BlogPostSchedule | null>;
  cancelSchedule(input: {
    siteId: SiteId | string;
    postId: BlogPostId | string;
    scheduleId: string;
    actorId: ContentActorId;
    requestId: string;
    occurredAt: string;
    authority?: McpBlogScheduleAuthority;
  }): Promise<BlogPostSchedule>;
  listDueSchedules(
    now: string,
    limit: number,
  ): Promise<ReadonlyArray<BlogPostSchedule>>;
  cancelSchedulesForSuccessor(input: {
    siteId: SiteId | string;
    postId: BlogPostId | string;
    workspaceId: ContentWorkspaceId;
    contentRevision: number;
    occurredAt: string;
  }): Promise<void>;
  claimSchedule(input: {
    scheduleId: string;
    now: string;
    executionId: string;
    publicationIdempotencyKey: string;
    attemptActorId: string;
    attemptRequestId: string;
    leaseToken: string;
    leaseExpiresAt: string;
  }): Promise<BlogPostScheduleClaim>;
  findExecution(
    executionId: string,
  ): Promise<BlogPostScheduleExecution | null>;
  listPendingExecutions(
    limit: number,
  ): Promise<ReadonlyArray<BlogPostScheduleExecution>>;
  retryExecution(input: {
    executionId: string;
    approvalAuthorityValid: boolean;
    leaseToken: string;
    leaseExpiresAt: string;
    updatedAt: string;
    actorId: string;
    requestId: string;
    retryKind: "human" | "scheduler";
  }): Promise<BlogPostScheduleExecutionLease>;
  recordExecutionOutcome(input: {
    executionId: string;
    leaseToken: string;
    attempt: number;
    outcomeId: string;
    outcome: Exclude<BlogPostScheduleExecution["state"], "claimed">;
    detail: string | null;
    updatedAt: string;
  }): Promise<BlogPostScheduleExecution>;
  archive(input: {
    actorId: ContentActorId;
    siteId: SiteId | string;
    postId: BlogPostId | string;
    selectedPostRevisionId: string;
    idempotencyKey: string;
    occurredAt: string;
  }): Promise<BlogPostArchiveResult>;
  confirmArchiveWithdrawal(input: {
    siteId: SiteId | string;
    postId: BlogPostId | string;
    publicationId: string;
    occurredAt: string;
  }): Promise<BlogPostOperationalState>;
  bindArchiveWithdrawal(input: {
    siteId: SiteId | string;
    postId: BlogPostId | string;
    publicationId: string;
    occurredAt: string;
    acceptedContinuation?: {
      actorId: ContentActorId;
      requestId: string;
      approvalId: ContentApprovalId;
      beforeState: unknown;
      afterState: unknown;
    };
  }): Promise<void>;
  bindArchiveWithdrawalDraft(input: {
    siteId: SiteId | string;
    postId: BlogPostId | string;
    workspaceId: ContentWorkspaceId;
    contentRevision: number;
    createdBy: ContentActorId;
    requestId: string;
    occurredAt: string;
  }): Promise<void>;
  grantArchiveWithdrawalRecoveryAccess(input: {
    siteId: SiteId | string;
    postId: BlogPostId | string;
    archiveRequestId: string;
    workspaceId: ContentWorkspaceId;
    actorId: ContentActorId;
    requestId: string;
    occurredAt: string;
  }): Promise<void>;
  recordRestoreProvenance(input: {
    siteId: SiteId | string;
    postId: BlogPostId | string;
    sourcePostRevisionId: string;
    workspaceId: ContentWorkspaceId;
    contentRevision: number;
    restoredPostRevisionId: string;
    actorId: ContentActorId;
    requestId: string;
    occurredAt: string;
  }): Promise<void>;
  claimRestore(input: {
    actorId: ContentActorId;
    siteId: SiteId | string;
    postId: BlogPostId | string;
    selectedPostRevisionId: string;
    idempotencyKey: string;
    occurredAt: string;
  }): Promise<void>;
  recordAudit(event: BlogPostOperationAuditEvent): Promise<void>;
  restore(input: {
    actorId: ContentActorId;
    siteId: SiteId | string;
    postId: BlogPostId | string;
    selectedPostRevisionId: string;
    idempotencyKey: string;
    occurredAt: string;
    provenance?: {
      workspaceId: ContentWorkspaceId;
      contentRevision: number;
      restoredPostRevisionId: string;
    };
  }): Promise<RestoredBlogPostDraft>;
}>;

export type BlogPostOperationAuditEvent = Readonly<{
  siteId: SiteId | string;
  postId: BlogPostId | string | null;
  actorId: string;
  commandType: string;
  requestId: string;
  outcome: "accepted" | "rejected";
  reasonCode: string;
  beforeState: unknown;
  afterState: unknown;
  occurredAt: string;
}>;

function requireIdempotencyKey(value: string) {
  if (!/^[A-Za-z0-9._:-]{16,128}$/u.test(value)) {
    throw new BlogPostOperationError("idempotency_key_invalid");
  }
}

function civilParts(instant: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return Object.fromEntries(
    formatter
      .formatToParts(instant)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value]),
  );
}

function offsetAt(instant: Date, timeZone: string): string {
  const parts = civilParts(instant, timeZone);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const minutes = Math.round((asUtc - instant.getTime()) / 60_000);
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

function localDateTimeAt(instant: Date, timeZone: string): string {
  const parts = civilParts(instant, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

export function resolvePostPublicationInstant(
  publishAt: string,
  reportingTimeZone: string,
): Omit<ResolvedPostPublicationTime, "timeZoneDatabaseVersion"> {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(
      publishAt,
    )
  ) {
    throw new BlogPostOperationError("schedule_instant_invalid");
  }
  const instant = new Date(publishAt);
  if (!Number.isFinite(instant.getTime())) {
    throw new BlogPostOperationError("schedule_instant_invalid");
  }
  try {
    return {
      localDateTime: localDateTimeAt(instant, reportingTimeZone),
      ianaTimeZone: reportingTimeZone,
      utcOffsetChoice: offsetAt(instant, reportingTimeZone),
      executeAtUtc: instant.toISOString(),
    };
  } catch {
    throw new BlogPostOperationError("iana_time_zone_invalid");
  }
}

function nextValidCivilTimes(localDateTime: string, timeZone: string) {
  const approximate = Date.parse(`${localDateTime}Z`);
  const alternatives: Array<Readonly<{
    localDateTime: string;
    utcOffset: string;
    executeAtUtc: string;
  }>> = [];
  for (
    let delta = -24 * 60;
    delta <= 24 * 60 && alternatives.length < 2;
    delta += 1
  ) {
    const instant = new Date(approximate + delta * 60_000);
    const local = localDateTimeAt(instant, timeZone);
    if (
      local > localDateTime &&
      !alternatives.some(({ localDateTime: prior }) => prior === local)
    ) {
      alternatives.push({
        localDateTime: local,
        utcOffset: offsetAt(instant, timeZone),
        executeAtUtc: instant.toISOString(),
      });
    }
  }
  return alternatives;
}

function requireResolvedCivilTime(input: {
  localDateTime: string;
  ianaTimeZone: string;
  utcOffsetChoice: string;
  executeAtUtc: string;
}) {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u.test(
      input.localDateTime,
    ) ||
    !/^[+-]\d{2}:\d{2}$/u.test(input.utcOffsetChoice)
  ) {
    throw new BlogPostOperationError("local_time_invalid");
  }
  const instant = new Date(input.executeAtUtc);
  if (
    Number.isNaN(instant.getTime()) ||
    instant.toISOString() !== input.executeAtUtc
  ) {
    throw new BlogPostOperationError("utc_instant_invalid");
  }
  try {
    if (
      localDateTimeAt(instant, input.ianaTimeZone) !==
        input.localDateTime ||
      offsetAt(instant, input.ianaTimeZone) !== input.utcOffsetChoice
    ) {
      throw new BlogPostOperationError(
        "civil_time_resolution_mismatch",
        {
          validAlternatives: nextValidCivilTimes(
            input.localDateTime,
            input.ianaTimeZone,
          ),
        },
      );
    }
  } catch (error) {
    if (error instanceof BlogPostOperationError) {
      throw error;
    }
    throw new BlogPostOperationError("iana_time_zone_invalid");
  }
  return instant;
}

export function createBlogPostOperationsApplication({
  store,
  now = () => new Date().toISOString(),
  createId = (kind) => `${kind}_${crypto.randomUUID()}`,
  validateApprovalAuthority = async () => true,
  timeZoneDatabaseVersion = () =>
    (
      globalThis as typeof globalThis & {
        process?: { versions?: { tz?: string } };
      }
    ).process?.versions?.tz,
}: {
  store: BlogPostOperationsStore;
  now?: () => string;
  createId?: (
    kind: "schedule" | "schedule_proposal" | "execution"
  ) => string;
  validateApprovalAuthority?: (
    approvalId: ContentApprovalId,
    ownedPublicationIdempotencyKey?: string,
  ) => Promise<boolean>;
  timeZoneDatabaseVersion?: () => string | undefined;
}) {
  async function audited<Result>(
    input: {
      siteId: SiteId | string;
      postId: BlogPostId | string | null;
      actorId: string;
      commandType: string;
      requestId: string;
    },
    operation: () => Promise<Result>,
  ) {
    const before =
      input.postId === null
        ? null
        : await store.findPost(input.siteId, input.postId);
    try {
      return await operation();
    } catch (error) {
      await store.recordAudit({
        ...input,
        outcome: "rejected",
        reasonCode:
          error instanceof BlogPostOperationError
            ? error.code
            : "blog_post_operation_rejected",
        beforeState: before,
        afterState: before,
        occurredAt: now(),
      });
      throw error;
    }
  }

  async function requireHumanContentAuthority(input: {
    siteId: SiteId | string;
    actorId: ContentActorId;
  }) {
    if (!(await store.hasHumanContentAuthority(input))) {
      throw new BlogPostOperationError("human_authority_required");
    }
  }

  async function requireScheduleProposalAuthority(input: {
    siteId: SiteId | string;
    postId: BlogPostId | string;
    actorId: ContentActorId;
  }) {
    if (!(await store.hasScheduleProposalAuthority(input))) {
      throw new BlogPostOperationError(
        "schedule_proposal_authority_required",
      );
    }
  }

  async function requireMcpScheduleAuthority(
    siteId: SiteId | string,
    authority: McpBlogScheduleAuthority,
  ) {
    if (
      !(await store.hasMcpScheduleAuthority({
        siteId,
        connectionId: authority.connectionId,
        actorId: authority.actorId,
        requiredScopes: authority.requiredScopes,
      }))
    ) {
      throw new BlogPostOperationError(
        "mcp_schedule_authority_required",
      );
    }
  }

  async function retryExecutionForActor(input: {
    siteId: SiteId | string;
    postId: BlogPostId | string;
    executionId: string;
    actorId: ContentActorId | "system:scheduler";
    requestId?: string;
    retryKind: "human" | "scheduler";
  }) {
    const observedAt = now();
    const durableRequestId =
      input.requestId ?? `${input.executionId}:${observedAt}`;
    return audited(
      {
        siteId: input.siteId,
        postId: input.postId,
        actorId: input.actorId,
        commandType: "blog.post.schedule.retry",
        requestId: durableRequestId,
      },
      async () => {
        if (input.retryKind === "human") {
          await requireHumanContentAuthority({
            siteId: input.siteId,
            actorId: input.actorId as ContentActorId,
          });
        }
        const execution = await store.findExecution(input.executionId);
        const schedule =
          execution === null
            ? null
            : await store.findSchedule(execution.scheduleId);
        if (
          execution === null ||
          schedule === null ||
          schedule.siteId !== input.siteId ||
          schedule.postId !== input.postId
        ) {
          throw new BlogPostOperationError("execution_not_found");
        }
        const approvalAuthorityValid =
          await validateApprovalAuthority(
            schedule.approvalId,
            execution.publicationIdempotencyKey,
          );
        return store.retryExecution({
          executionId: input.executionId,
          approvalAuthorityValid,
          leaseToken: crypto.randomUUID(),
          leaseExpiresAt: new Date(
            new Date(observedAt).getTime() + 5 * 60_000,
          ).toISOString(),
          updatedAt: observedAt,
          actorId: input.actorId,
          requestId: durableRequestId,
          retryKind: input.retryKind,
        });
      },
    );
  }

  return Object.freeze({
    queries: Object.freeze({
      async getSchedule(
        siteId: SiteId | string,
        scheduleId: string,
      ) {
        const schedule = await store.findSchedule(scheduleId);
        return schedule?.siteId === siteId ? schedule : null;
      },
      async getExecution(
        siteId: SiteId | string,
        executionId: string,
      ) {
        const execution = await store.findExecution(executionId);
        if (execution === null) {
          return null;
        }
        const schedule = await store.findSchedule(execution.scheduleId);
        return schedule?.siteId === siteId ? execution : null;
      },
      findSchedulablePostForApproval(input: {
        siteId: SiteId | string;
        workspaceId: ContentWorkspaceId;
        contentRevision: number;
        approvalId: ContentApprovalId;
      }) {
        return store.findSchedulablePostForApproval(input);
      },
      getApproval(approvalId: ContentApprovalId) {
        return store.findApproval(approvalId);
      },
      findScheduleByRequest(input: {
        siteId: SiteId | string;
        postId: BlogPostId | string;
        idempotencyKey: string;
      }) {
        return store.findScheduleByRequest(input);
      },
      findScheduleByWorkspaceRequest(input: {
        siteId: SiteId | string;
        workspaceId: ContentWorkspaceId;
        idempotencyKey: string;
      }) {
        return store.findScheduleByWorkspaceRequest(input);
      },
      findScheduleCancellationByRequest(input: {
        siteId: SiteId | string;
        requestId: string;
      }) {
        return store.findScheduleCancellationByRequest(input);
      },
    }),
    commands: Object.freeze({
      recordRejectedCommand(input: {
        actorId: ContentActorId;
        siteId: SiteId | string;
        postId: BlogPostId | string | null;
        commandType: string;
        requestId: string;
        reasonCode: string;
      }) {
        return store.recordAudit({
          ...input,
          outcome: "rejected",
          beforeState: null,
          afterState: null,
          occurredAt: now(),
        });
      },
      async proposeSchedule(input: {
        actorId: ContentActorId;
        siteId: SiteId | string;
        postId: BlogPostId | string;
        resolvedTime: Omit<
          ResolvedPostPublicationTime,
          "timeZoneDatabaseVersion"
        >;
        idempotencyKey: string;
      }) {
        return audited(
          {
            siteId: input.siteId,
            postId: input.postId,
            actorId: input.actorId,
            commandType: "blog.post.schedule.propose",
            requestId: input.idempotencyKey,
          },
          async () => {
            await requireScheduleProposalAuthority(input);
            requireIdempotencyKey(input.idempotencyKey);
            const replay = await store.findScheduleProposalByRequest({
              siteId: input.siteId,
              postId: input.postId,
              idempotencyKey: input.idempotencyKey,
            });
            if (replay !== null) {
              if (
                replay.siteId !== input.siteId ||
                replay.postId !== input.postId ||
                replay.localDateTime !== input.resolvedTime.localDateTime ||
                replay.ianaTimeZone !== input.resolvedTime.ianaTimeZone ||
                replay.utcOffsetChoice !==
                  input.resolvedTime.utcOffsetChoice ||
                replay.executeAtUtc !== input.resolvedTime.executeAtUtc ||
                replay.createdBy !== input.actorId
              ) {
                throw new BlogPostOperationError(
                  "idempotency_key_conflict",
                );
              }
              return replay;
            }
            requireResolvedCivilTime(input.resolvedTime);
            const post = await store.findPost(input.siteId, input.postId);
            if (post === null || post.collectionState !== "active") {
              throw new BlogPostOperationError("post_not_active");
            }
            const tzdbVersion = timeZoneDatabaseVersion();
            if (
              tzdbVersion === undefined ||
              !/^[0-9]{4}[a-z]$/u.test(tzdbVersion)
            ) {
              throw new BlogPostOperationError(
                "time_zone_database_version_unavailable",
              );
            }
            const proposalId = createId("schedule_proposal");
            return store.saveScheduleProposal(
              {
                id: proposalId,
                siteId: post.siteId,
                postId: post.postId,
                workspaceId: post.workspaceId,
                contentRevision: post.contentRevision,
                postRevisionId: post.postRevisionId,
                authorityVersion: post.version,
                ...input.resolvedTime,
                timeZoneDatabaseVersion: tzdbVersion,
                createdBy: input.actorId,
                proposalAuditId:
                  `blog.post.schedule.proposal:${proposalId}`,
                createdAt: now(),
              },
              input.idempotencyKey,
            );
          },
        );
      },
      async activateSchedule(input: {
        actorId: ContentActorId;
        siteId: SiteId | string;
        postId: BlogPostId | string;
        approvalId: ContentApprovalId;
        resolvedTime: Omit<
          ResolvedPostPublicationTime,
          "timeZoneDatabaseVersion"
        >;
        idempotencyKey: string;
        authority?: McpBlogScheduleAuthority;
      }) {
        return audited(
          {
            siteId: input.siteId,
            postId: input.postId,
            actorId: input.actorId,
            commandType: "blog.post.schedule.activate",
            requestId: input.idempotencyKey,
          },
          async () => {
            if (input.authority === undefined) {
              await requireHumanContentAuthority(input);
            } else {
              await requireMcpScheduleAuthority(
                input.siteId,
                input.authority,
              );
            }
            requireIdempotencyKey(input.idempotencyKey);
            const replay = await store.findScheduleByRequest({
              siteId: input.siteId,
              postId: input.postId,
              idempotencyKey: input.idempotencyKey,
            });
            if (replay !== null) {
              if (
                replay.approvalId !== input.approvalId ||
                replay.localDateTime !== input.resolvedTime.localDateTime ||
                replay.ianaTimeZone !== input.resolvedTime.ianaTimeZone ||
                replay.utcOffsetChoice !==
                  input.resolvedTime.utcOffsetChoice ||
                replay.executeAtUtc !== input.resolvedTime.executeAtUtc ||
                replay.createdBy !== input.actorId ||
                replay.activatedBy !== input.actorId
              ) {
                throw new BlogPostOperationError(
                  "idempotency_key_conflict",
                );
              }
              return replay;
            }
            const instant = requireResolvedCivilTime(input.resolvedTime);
            const tzdbVersion = timeZoneDatabaseVersion();
            if (
              tzdbVersion === undefined ||
              !/^[0-9]{4}[a-z]$/u.test(tzdbVersion)
            ) {
              throw new BlogPostOperationError(
                "time_zone_database_version_unavailable",
              );
            }
            const [post, approval] = await Promise.all([
              store.findPost(input.siteId, input.postId),
              store.findApproval(input.approvalId),
            ]);
            if (
              post === null ||
              post.collectionState !== "active"
            ) {
              throw new BlogPostOperationError("post_not_active");
            }
            const approvedArtifact = approval?.postArtifacts.find(
              ({ postId }) => postId === post.postId,
            );
            if (
              approval === null ||
              approval.siteId !== input.siteId ||
              approval.invalidatedAt !== null ||
              approvedArtifact === undefined ||
              !(await store.hasCurrentApprovalAuthority({
                siteId: post.siteId,
                postId: post.postId,
                approvalId: approval.id,
                workspaceId: approval.workspaceId,
                contentRevision: approval.contentRevision,
                postRevisionId: approvedArtifact.postRevisionId,
                authorityPostRevisionId: post.postRevisionId,
                approvalFingerprint: approval.fingerprint,
                authorityVersion: post.version,
              }))
            ) {
              throw new BlogPostOperationError("approval_stale");
            }
            if (!(await validateApprovalAuthority(approval.id))) {
              throw new BlogPostOperationError("approval_stale");
            }
            const activatedAt = now();
            if (instant.getTime() <= new Date(activatedAt).getTime()) {
              throw new BlogPostOperationError("schedule_in_past");
            }
            const scheduleId = createId("schedule");
            return store.saveSchedule(
              Object.freeze({
                id: scheduleId,
                siteId: post.siteId,
                postId: post.postId,
                workspaceId: approval.workspaceId,
                contentRevision: approval.contentRevision,
                postRevisionId: approvedArtifact.postRevisionId,
                approvalId: approval.id,
                approvalFingerprint: approval.fingerprint,
                authorityPostRevisionId: post.postRevisionId,
                authorityVersion: post.version,
                ...input.resolvedTime,
                timeZoneDatabaseVersion: tzdbVersion,
                createdBy: input.actorId,
                activatedBy: input.actorId,
                activationAuditId:
                  `blog.post.schedule.activation:${scheduleId}`,
                activatedAt,
                state: "active" as const,
                detail: null,
              }),
              input.idempotencyKey,
              input.authority,
            );
          },
        );
      },
      invalidateForSuccessorRevision: (
        input: {
          siteId: SiteId | string;
          postId: BlogPostId | string;
          workspaceId: ContentWorkspaceId;
          contentRevision: number;
          occurredAt: string;
        },
      ) => store.cancelSchedulesForSuccessor(input),
      async cancelSchedule(input: {
        actorId: ContentActorId;
        siteId: SiteId | string;
        postId: BlogPostId | string;
        scheduleId: string;
        idempotencyKey: string;
        authority?: McpBlogScheduleAuthority;
      }) {
        return audited(
          {
            siteId: input.siteId,
            postId: input.postId,
            actorId: input.actorId,
            commandType: "blog.post.schedule.cancel",
            requestId: input.idempotencyKey,
          },
          async () => {
            if (input.authority === undefined) {
              await requireHumanContentAuthority(input);
            } else {
              await requireMcpScheduleAuthority(
                input.siteId,
                input.authority,
              );
            }
            requireIdempotencyKey(input.idempotencyKey);
            return store.cancelSchedule({
              ...input,
              requestId: input.idempotencyKey,
              occurredAt: now(),
              ...(input.authority === undefined
                ? {}
                : { authority: input.authority }),
            });
          },
        );
      },
      async claimDueSchedule(
        siteId: SiteId | string,
        scheduleId: string,
      ) {
        const observedAt = now();
        const schedule = await store.findSchedule(scheduleId);
        return audited(
          {
            siteId,
            postId:
              schedule !== null && schedule.siteId === siteId
                ? schedule.postId
                : null,
            actorId: "system:scheduler",
            commandType: "blog.post.schedule.claim",
            requestId: `${scheduleId}:${observedAt}`,
          },
          async () => {
            if (schedule === null || schedule.siteId !== siteId) {
              throw new BlogPostOperationError("schedule_inactive");
            }
            if (
              schedule.state !== "active" &&
              schedule.state !== "claimed" &&
              schedule.state !== "unknown"
            ) {
              throw new BlogPostOperationError("schedule_inactive");
            }
            if (!(await validateApprovalAuthority(
              schedule.approvalId,
              `scheduled-publication:${scheduleId}`,
            ))) {
              throw new BlogPostOperationError("approval_stale");
            }
            if (schedule.state !== "active") {
              return store.claimSchedule({
                scheduleId,
                now: observedAt,
                executionId: createId("execution"),
                publicationIdempotencyKey:
                  `scheduled-publication:${scheduleId}`,
                attemptActorId: "system:scheduler",
                attemptRequestId: `${scheduleId}:${observedAt}`,
                leaseToken: crypto.randomUUID(),
                leaseExpiresAt: new Date(
                  new Date(observedAt).getTime() + 5 * 60_000,
                ).toISOString(),
              });
            }
            if (schedule.executeAtUtc > observedAt) {
              throw new BlogPostOperationError("schedule_not_due");
            }
            const claim = await store.claimSchedule({
              scheduleId,
              now: observedAt,
              executionId: createId("execution"),
              publicationIdempotencyKey:
                `scheduled-publication:${scheduleId}`,
              attemptActorId: "system:scheduler",
              attemptRequestId: `${scheduleId}:${observedAt}`,
              leaseToken: crypto.randomUUID(),
              leaseExpiresAt: new Date(
                new Date(observedAt).getTime() + 5 * 60_000,
              ).toISOString(),
            });
            if (claim.lease === null) {
              return claim;
            }
            const [approval, post] = await Promise.all([
              store.findApproval(schedule.approvalId),
              store.findPost(schedule.siteId, schedule.postId),
            ]);
            const currentApprovalAuthority =
              approval === null || post === null
                ? false
                : await store.hasCurrentApprovalAuthority({
                    siteId: schedule.siteId,
                    postId: schedule.postId,
                    approvalId: schedule.approvalId,
                    workspaceId: schedule.workspaceId,
                    contentRevision: schedule.contentRevision,
                    postRevisionId: schedule.postRevisionId,
                    authorityPostRevisionId:
                      schedule.authorityPostRevisionId,
                    approvalFingerprint: schedule.approvalFingerprint,
                    authorityVersion: schedule.authorityVersion,
                  });
            if (
              approval === null ||
              approval.siteId !== schedule.siteId ||
              approval.invalidatedAt !== null ||
              approval.fingerprint !== schedule.approvalFingerprint ||
              post === null ||
              post.collectionState !== "active" ||
              post.postRevisionId !== schedule.authorityPostRevisionId ||
              post.version !== schedule.authorityVersion ||
              !currentApprovalAuthority ||
              !approval.postArtifacts.some(
                ({ postId, postRevisionId }) =>
                  postId === schedule.postId &&
                  postRevisionId === schedule.postRevisionId,
              ) ||
              approval.workspaceId !== schedule.workspaceId ||
              approval.contentRevision !== schedule.contentRevision
            ) {
              const execution = await store.recordExecutionOutcome({
                executionId: claim.execution.executionId,
                leaseToken: claim.lease.leaseToken,
                attempt: claim.execution.attempt,
                outcomeId:
                  `${claim.execution.executionId}:${claim.execution.attempt}:approval_stale`,
                outcome: "blocked",
                detail: "approval_stale",
                updatedAt: observedAt,
              });
              return { execution, lease: null };
            }
            return claim;
          },
        );
      },
      async recordExecutionOutcome(input: {
        lease: BlogPostScheduleExecutionLease;
        outcomeId: string;
        outcome: Exclude<BlogPostScheduleExecution["state"], "claimed">;
        detail: string | null;
      }) {
        return audited(
          {
            siteId: input.lease.siteId,
            postId: input.lease.postId,
            actorId: "system:scheduler",
            commandType: "blog.post.schedule.outcome",
            requestId: input.outcomeId,
          },
          async () => {
            const schedule = await store.findSchedule(
              input.lease.execution.scheduleId,
            );
            if (
              schedule === null ||
              schedule.siteId !== input.lease.siteId ||
              schedule.postId !== input.lease.postId
            ) {
              throw new BlogPostOperationError("schedule_inactive");
            }
            return store.recordExecutionOutcome({
              executionId: input.lease.execution.executionId,
              leaseToken: input.lease.leaseToken,
              attempt: input.lease.execution.attempt,
              outcomeId: input.outcomeId,
              outcome: input.outcome,
              detail: input.detail,
              updatedAt: now(),
            });
          },
        );
      },
      async retryExecution(
        siteId: SiteId | string,
        postId: BlogPostId | string,
        executionId: string,
        actorId: ContentActorId,
        requestId?: string,
      ) {
        return retryExecutionForActor({
          siteId,
          postId,
          executionId,
          actorId,
          requestId,
          retryKind: "human",
        });
      },
      retryExecutionAsScheduler(
        siteId: SiteId | string,
        postId: BlogPostId | string,
        executionId: string,
        requestId?: string,
      ) {
        return retryExecutionForActor({
          siteId,
          postId,
          executionId,
          actorId: "system:scheduler",
          requestId,
          retryKind: "scheduler",
        });
      },
      archive(input: {
        actorId: ContentActorId;
        siteId: SiteId | string;
        postId: BlogPostId | string;
        selectedPostRevisionId: string;
        idempotencyKey: string;
      }) {
        return audited(
          {
            siteId: input.siteId,
            postId: input.postId,
            actorId: input.actorId,
            commandType: "blog.post.archive",
            requestId: input.idempotencyKey,
          },
          async () => {
            await requireHumanContentAuthority(input);
            requireIdempotencyKey(input.idempotencyKey);
            return store.archive({ ...input, occurredAt: now() });
          },
        );
      },
      confirmArchiveWithdrawal(input: {
        siteId: SiteId | string;
        postId: BlogPostId | string;
        publicationId: string;
      }) {
        const occurredAt = now();
        return audited(
          {
            siteId: input.siteId,
            postId: input.postId,
            actorId: "system:publication",
            commandType: "blog.post.archive.withdrawal.verified",
            requestId: input.publicationId,
          },
          () => store.confirmArchiveWithdrawal({
            ...input,
            occurredAt,
          }),
        );
      },
      bindArchiveWithdrawal(input: {
        siteId: SiteId | string;
        postId: BlogPostId | string;
        publicationId: string;
        occurredAt: string;
        acceptedContinuation?: {
          actorId: ContentActorId;
          requestId: string;
          approvalId: ContentApprovalId;
          beforeState: unknown;
          afterState: unknown;
        };
      }) {
        return audited(
          {
            siteId: input.siteId,
            postId: input.postId,
            actorId: "system:publication",
            commandType: "blog.post.archive.withdrawal.bind",
            requestId: input.publicationId,
          },
          () => store.bindArchiveWithdrawal(input),
        );
      },
      bindArchiveWithdrawalDraft(input: {
        siteId: SiteId | string;
        postId: BlogPostId | string;
        workspaceId: ContentWorkspaceId;
        contentRevision: number;
        createdBy: ContentActorId;
        requestId: string;
        occurredAt: string;
      }) {
        return audited(
          {
            siteId: input.siteId,
            postId: input.postId,
            actorId: input.createdBy,
            commandType: "blog.post.archive.withdrawal.draft",
            requestId: input.requestId,
          },
          () => store.bindArchiveWithdrawalDraft(input),
        );
      },
      restore(input: {
        actorId: ContentActorId;
        siteId: SiteId | string;
        postId: BlogPostId | string;
        selectedPostRevisionId: string;
        idempotencyKey: string;
        provenance?: {
          workspaceId: ContentWorkspaceId;
          contentRevision: number;
          restoredPostRevisionId: string;
        };
      }) {
        return audited(
          {
            siteId: input.siteId,
            postId: input.postId,
            actorId: input.actorId,
            commandType: "blog.post.restore",
            requestId: input.idempotencyKey,
          },
          async () => {
            await requireHumanContentAuthority(input);
            requireIdempotencyKey(input.idempotencyKey);
            return store.restore({ ...input, occurredAt: now() });
          },
        );
      },
    }),
  });
}

export function createInMemoryBlogPostOperationsStore(seed: {
  posts?: ReadonlyArray<BlogPostOperationalState>;
  approvals?: ReadonlyArray<BlogPostApprovalEvidence>;
  humanActorIds?: ReadonlyArray<string>;
  mcpScheduleProposalAccess?: ReadonlyArray<{
    actorId: string;
    siteId: SiteId | string;
    postId: BlogPostId | string;
  }>;
  mcpScheduleAccess?: ReadonlyArray<{
    connectionId: string;
    actorId: string;
    siteId: SiteId | string;
  }>;
} = {}) {
  type StoredExecution = BlogPostScheduleExecution & {
    leaseToken: string;
  };
  const postKey = (siteId: SiteId | string, postId: BlogPostId | string) =>
    `${siteId}\0${postId}`;
  const posts = new Map(
    (seed.posts ?? []).map((post) => [
      postKey(post.siteId, post.postId),
      post,
    ]),
  );
  const approvals = new Map(
    (seed.approvals ?? []).map((approval) => [approval.id, approval]),
  );
  const humanActorIds = new Set(
    seed.humanActorIds ?? [],
  );
  const mcpScheduleProposalAccess = new Set(
    (seed.mcpScheduleProposalAccess ?? []).map(
      ({ actorId, siteId, postId }) =>
        `${actorId}\0${siteId}\0${postId}`,
    ),
  );
  const mcpScheduleAccess = new Set(
    (seed.mcpScheduleAccess ?? []).map(
      ({ connectionId, actorId, siteId }) =>
        `${connectionId}\0${actorId}\0${siteId}`,
    ),
  );
  const schedules = new Map<string, BlogPostSchedule>();
  const scheduleAuthorities = new Map<string, McpBlogScheduleAuthority>();
  const scheduleRequests = new Map<string, BlogPostSchedule>();
  const scheduleRequestKeys = new Map<string, string>();
  const scheduleProposals = new Map<string, BlogPostScheduleProposal>();
  const scheduleProposalRequests = new Map<
    string,
    BlogPostScheduleProposal
  >();
  const scheduleCancellationRequests = new Map<
    string,
    Readonly<{
      scheduleId: string;
      actorId: ContentActorId;
      result: BlogPostSchedule;
    }>
  >();
  const executions = new Map<string, StoredExecution>();
  const executionBySchedule = new Map<string, string>();
  const retryRequests = new Map<
    string,
    Readonly<{
      executionId: string;
      actorId: string;
      lease: BlogPostScheduleExecutionLease;
    }>
  >();
  const executionOutcomeRequests = new Map<
    string,
    Readonly<{
      executionId: string;
      attempt: number;
      outcome: Exclude<BlogPostScheduleExecution["state"], "claimed">;
      detail: string | null;
      result: BlogPostScheduleExecution;
    }>
  >();
  const archiveRequests = new Map<
    string,
    Readonly<{
      actorId: ContentActorId;
      selectedPostRevisionId: string;
      result: BlogPostArchiveResult;
    }>
  >();
  const restoreRequests = new Map<
    string,
    Readonly<{
      actorId: ContentActorId;
      selectedPostRevisionId: string;
      result: RestoredBlogPostDraft;
    }>
  >();
  const withdrawalDrafts = new Map<
    string,
    Readonly<{ workspaceId: ContentWorkspaceId; contentRevision: number }>
  >();
  const withdrawalPublications = new Map<string, string>();
  const revisionHistory = new Map<string, Set<string>>();
  const restoreProvenance: Array<Parameters<
    BlogPostOperationsStore["recordRestoreProvenance"]
  >[0]> = [];
  const auditEvents: BlogPostOperationAuditEvent[] = [];
  const publicExecution = ({
    leaseToken: _leaseToken,
    ...execution
  }: StoredExecution): BlogPostScheduleExecution =>
    Object.freeze(execution);
  for (const post of seed.posts ?? []) {
    revisionHistory.set(
      postKey(post.siteId, post.postId),
      new Set([post.postRevisionId]),
    );
  }

  const store: BlogPostOperationsStore & {
    countPostRevisionHistory(
      siteId: SiteId | string,
      postId: BlogPostId | string,
    ): Promise<number>;
  } = {
    async findPost(siteId, postId) {
      return posts.get(postKey(siteId, postId)) ?? null;
    },
    async findApproval(approvalId) {
      return approvals.get(approvalId) ?? null;
    },
    async hasCurrentApprovalAuthority(input) {
      const post = posts.get(postKey(input.siteId, input.postId));
      const approval = approvals.get(input.approvalId);
      return post !== undefined &&
        approval !== undefined &&
        approval.siteId === input.siteId &&
        approval.workspaceId === input.workspaceId &&
        approval.contentRevision === input.contentRevision &&
        approval.fingerprint === input.approvalFingerprint &&
        approval.invalidatedAt === null &&
        post.postRevisionId === input.authorityPostRevisionId &&
        post.version === input.authorityVersion &&
        approval.postArtifacts.some(
          ({ postId, postRevisionId }) =>
            postId === input.postId &&
            postRevisionId === input.postRevisionId,
        );
    },
    async saveScheduleProposal(proposal, idempotencyKey) {
      const requestKey =
        `${proposal.siteId}\0${idempotencyKey}`;
      const replay = scheduleProposalRequests.get(requestKey);
      if (replay !== undefined) {
        if (
          replay.workspaceId !== proposal.workspaceId ||
          replay.contentRevision !== proposal.contentRevision ||
          replay.postRevisionId !== proposal.postRevisionId ||
          replay.authorityVersion !== proposal.authorityVersion ||
          replay.localDateTime !== proposal.localDateTime ||
          replay.ianaTimeZone !== proposal.ianaTimeZone ||
          replay.utcOffsetChoice !== proposal.utcOffsetChoice ||
          replay.executeAtUtc !== proposal.executeAtUtc ||
          replay.timeZoneDatabaseVersion !==
            proposal.timeZoneDatabaseVersion ||
          replay.createdBy !== proposal.createdBy ||
          replay.proposalAuditId !== proposal.proposalAuditId
        ) {
          throw new BlogPostOperationError("idempotency_key_conflict");
        }
        return replay;
      }
      scheduleProposals.set(proposal.id, proposal);
      scheduleProposalRequests.set(requestKey, proposal);
      await store.recordAudit({
        siteId: proposal.siteId,
        postId: proposal.postId,
        actorId: proposal.createdBy,
        commandType: "blog.post.schedule.propose",
        requestId: idempotencyKey,
        outcome: "accepted",
        reasonCode: "accepted",
        beforeState: posts.get(
          postKey(proposal.siteId, proposal.postId),
        ) ?? null,
        afterState: proposal,
        occurredAt: proposal.createdAt,
      });
      return proposal;
    },
    async findScheduleProposalByRequest(input) {
      return scheduleProposalRequests.get(
        `${input.siteId}\0${input.idempotencyKey}`,
      ) ?? null;
    },
    async hasHumanContentAuthority(input) {
      return humanActorIds.has(input.actorId);
    },
    async hasScheduleProposalAuthority(input) {
      return humanActorIds.has(input.actorId) ||
        mcpScheduleProposalAccess.has(
          `${input.actorId}\0${input.siteId}\0${input.postId}`,
        );
    },
    async hasMcpScheduleAuthority(input) {
      return mcpScheduleAccess.has(
        `${input.connectionId}\0${input.actorId}\0${input.siteId}`,
      );
    },
    async findMcpScheduleAuthority(scheduleId) {
      return scheduleAuthorities.get(scheduleId) ?? null;
    },
    async findSchedulablePostForApproval(input) {
      const approval = approvals.get(input.approvalId);
      if (
        approval === undefined ||
        approval.siteId !== input.siteId ||
        approval.workspaceId !== input.workspaceId ||
        approval.contentRevision !== input.contentRevision ||
        approval.invalidatedAt !== null
      ) {
        return null;
      }
      const candidates = [...posts.values()].filter(
        (post) =>
          post.siteId === input.siteId &&
          post.workspaceId === input.workspaceId &&
          post.contentRevision === input.contentRevision &&
          post.collectionState === "active" &&
          approval.postArtifacts.some(
            ({ postId, postRevisionId }) =>
              postId === post.postId &&
              postRevisionId === post.postRevisionId,
          ),
      );
      return candidates.length === 1 ? candidates[0]! : null;
    },
    async saveSchedule(schedule, idempotencyKey, authority) {
      if (
        authority !== undefined &&
        !mcpScheduleAccess.has(
          `${authority.connectionId}\0${authority.actorId}\0${schedule.siteId}`,
        )
      ) {
        throw new BlogPostOperationError(
          "mcp_schedule_authority_required",
        );
      }
      const requestKey = `${schedule.workspaceId}\0${idempotencyKey}`;
      const replay = scheduleRequests.get(requestKey);
      if (replay !== undefined) {
        if (
          replay.siteId !== schedule.siteId ||
          replay.postId !== schedule.postId ||
          replay.workspaceId !== schedule.workspaceId ||
          replay.contentRevision !== schedule.contentRevision ||
          replay.postRevisionId !== schedule.postRevisionId ||
          replay.approvalId !== schedule.approvalId ||
          replay.approvalFingerprint !== schedule.approvalFingerprint ||
          replay.authorityPostRevisionId !==
            schedule.authorityPostRevisionId ||
          replay.authorityVersion !== schedule.authorityVersion ||
          replay.localDateTime !== schedule.localDateTime ||
          replay.ianaTimeZone !== schedule.ianaTimeZone ||
          replay.utcOffsetChoice !== schedule.utcOffsetChoice ||
          replay.executeAtUtc !== schedule.executeAtUtc ||
          replay.timeZoneDatabaseVersion !==
            schedule.timeZoneDatabaseVersion ||
          replay.createdBy !== schedule.createdBy ||
          replay.activatedBy !== schedule.activatedBy
        ) {
          throw new BlogPostOperationError("idempotency_key_conflict");
        }
        return replay;
      }
      for (const [id, existing] of schedules) {
        if (
          existing.siteId === schedule.siteId &&
          existing.postId === schedule.postId &&
          existing.state === "active"
        ) {
          schedules.set(id, {
            ...existing,
            state: "cancelled",
            detail: "rescheduled",
          });
        }
      }
      schedules.set(schedule.id, schedule);
      if (authority !== undefined) {
        scheduleAuthorities.set(schedule.id, authority);
      }
      scheduleRequests.set(requestKey, schedule);
      scheduleRequestKeys.set(schedule.id, idempotencyKey);
      const key = postKey(schedule.siteId, schedule.postId);
      const post = posts.get(key);
      let after: BlogPostOperationalState | null = null;
      if (post !== undefined) {
        after = {
          ...post,
          workflowState: "scheduled",
        };
        posts.set(key, after);
      }
      await store.recordAudit({
        siteId: schedule.siteId,
        postId: schedule.postId,
        actorId: schedule.activatedBy,
        commandType: "blog.post.schedule.activate",
        requestId: idempotencyKey,
        outcome: "accepted",
        reasonCode: "accepted",
        beforeState: post ?? null,
        afterState: after,
        occurredAt: schedule.activatedAt,
      });
      return schedule;
    },
    async findScheduleByRequest(input) {
      return [...schedules.values()].find(
        (schedule) =>
          schedule.siteId === input.siteId &&
          schedule.postId === input.postId &&
          scheduleRequestKeys.get(schedule.id) === input.idempotencyKey,
      ) ?? null;
    },
    async findScheduleByWorkspaceRequest(input) {
      return [...schedules.values()].find(
        (schedule) =>
          schedule.siteId === input.siteId &&
          schedule.workspaceId === input.workspaceId &&
          scheduleRequestKeys.get(schedule.id) === input.idempotencyKey,
      ) ?? null;
    },
    async findSchedule(scheduleId) {
      return schedules.get(scheduleId) ?? null;
    },
    async findScheduleCancellationByRequest(input) {
      return scheduleCancellationRequests.get(
        `${input.siteId}\0${input.requestId}`,
      )?.result ?? null;
    },
    async cancelSchedule(input) {
      if (
        input.authority !== undefined &&
        !mcpScheduleAccess.has(
          `${input.authority.connectionId}\0${input.authority.actorId}\0${input.siteId}`,
        )
      ) {
        throw new BlogPostOperationError(
          "mcp_schedule_authority_required",
        );
      }
      const requestKey =
        `${input.siteId}\0${input.requestId}`;
      const replay = scheduleCancellationRequests.get(requestKey);
      if (replay !== undefined) {
        if (
          replay.scheduleId !== input.scheduleId ||
          replay.actorId !== input.actorId ||
          replay.result.postId !== input.postId
        ) {
          throw new BlogPostOperationError("idempotency_key_conflict");
        }
        return replay.result;
      }
      const schedule = schedules.get(input.scheduleId);
      if (
        schedule === undefined ||
        schedule.siteId !== input.siteId ||
        schedule.postId !== input.postId
      ) {
        throw new BlogPostOperationError("schedule_not_found");
      }
      if (schedule.state !== "active") {
        throw new BlogPostOperationError("too_late_to_cancel");
      }
      const cancelled = Object.freeze({
        ...schedule,
        state: "cancelled" as const,
        detail: "human_cancelled",
      });
      schedules.set(schedule.id, cancelled);
      const key = postKey(schedule.siteId, schedule.postId);
      const before = posts.get(key) ?? null;
      const after =
        before === null
          ? null
          : Object.freeze({ ...before, workflowState: "approved" as const });
      if (after !== null) {
        posts.set(key, after);
      }
      scheduleCancellationRequests.set(requestKey, {
        scheduleId: input.scheduleId,
        actorId: input.actorId,
        result: cancelled,
      });
      await store.recordAudit({
        siteId: input.siteId,
        postId: input.postId,
        actorId: input.actorId,
        commandType: "blog.post.schedule.cancel",
        requestId: input.requestId,
        outcome: "accepted",
        reasonCode: "accepted",
        beforeState: before,
        afterState: cancelled,
        occurredAt: input.occurredAt,
      });
      return cancelled;
    },
    async listDueSchedules(observedAt, limit) {
      return [...schedules.values()]
        .filter(
          (schedule) =>
            schedule.state === "active" &&
            schedule.executeAtUtc <= observedAt,
        )
        .sort((left, right) =>
          left.executeAtUtc.localeCompare(right.executeAtUtc)
        )
        .slice(0, limit);
    },
    async cancelSchedulesForSuccessor(input) {
      let projectsSuccessorWorkflow = false;
      for (const [id, schedule] of schedules) {
        if (
          schedule.siteId === input.siteId &&
          schedule.postId === input.postId &&
          (
            schedule.workspaceId !== input.workspaceId ||
            schedule.contentRevision < input.contentRevision
          )
        ) {
          projectsSuccessorWorkflow = true;
          if (schedule.state === "active") {
            schedules.set(id, {
              ...schedule,
              state: "cancelled",
              detail: "revision_changed",
            });
          }
        }
      }
      if (projectsSuccessorWorkflow) {
        const key = postKey(input.siteId, input.postId);
        const post = posts.get(key);
        if (post !== undefined) {
          posts.set(key, {
            ...post,
            workflowState: "editing",
          });
        }
      }
    },
    async claimSchedule(input) {
      const schedule = schedules.get(input.scheduleId);
      if (schedule === undefined) {
        throw new BlogPostOperationError("schedule_inactive");
      }
      const existingId = executionBySchedule.get(input.scheduleId);
      if (existingId !== undefined) {
        const existing = executions.get(existingId)!;
        if (
          (
            existing.state === "claimed" ||
            existing.state === "unknown"
          ) &&
          existing.leaseExpiresAt <= input.now
        ) {
          const reclaimed = {
            ...existing,
            attempt: existing.attempt + 1,
            attemptActorId: input.attemptActorId,
            attemptRequestId: input.attemptRequestId,
            state: "claimed" as const,
            leaseToken: input.leaseToken,
            leaseExpiresAt: input.leaseExpiresAt,
            updatedAt: input.now,
          };
          executions.set(existingId, reclaimed);
          const visible = publicExecution(reclaimed);
          return {
            execution: visible,
            lease: {
              siteId: schedule.siteId,
              postId: schedule.postId,
              execution: visible,
              leaseToken: input.leaseToken,
            },
          };
        }
        return { execution: publicExecution(existing), lease: null };
      }
      if (schedule.state !== "active") {
        throw new BlogPostOperationError("schedule_inactive");
      }
      const execution: StoredExecution = Object.freeze({
        executionId: input.executionId,
        scheduleId: input.scheduleId,
        publicationIdempotencyKey: input.publicationIdempotencyKey,
        scheduledInstant: schedule.executeAtUtc,
        attempt: 1,
        attemptActorId: input.attemptActorId,
        attemptRequestId: input.attemptRequestId,
        leaseToken: input.leaseToken,
        leaseExpiresAt: input.leaseExpiresAt,
        state: "claimed",
        detail: null,
        claimedAt: input.now,
        updatedAt: input.now,
      });
      schedules.set(input.scheduleId, {
        ...schedule,
        state: "claimed",
      });
      const key = postKey(schedule.siteId, schedule.postId);
      const post = posts.get(key);
      if (post !== undefined) {
        posts.set(key, {
          ...post,
          workflowState: "executing",
        });
      }
      executionBySchedule.set(input.scheduleId, execution.executionId);
      executions.set(execution.executionId, execution);
      const visible = publicExecution(execution);
      return {
        execution: visible,
        lease: {
          siteId: schedule.siteId,
          postId: schedule.postId,
          execution: visible,
          leaseToken: input.leaseToken,
        },
      };
    },
    async findExecution(executionId) {
      const execution = executions.get(executionId);
      return execution === undefined ? null : publicExecution(execution);
    },
    async listPendingExecutions(limit) {
      return [...executions.values()]
        .filter(({ state }) => state === "claimed" || state === "unknown")
        .sort((left, right) =>
          left.claimedAt.localeCompare(right.claimedAt)
        )
        .slice(0, limit)
        .map(publicExecution);
    },
    async retryExecution(input) {
      const existing = executions.get(input.executionId);
      if (existing === undefined) {
        throw new BlogPostOperationError("execution_not_retryable");
      }
      const schedule = schedules.get(existing.scheduleId);
      if (schedule === undefined) {
        throw new BlogPostOperationError("execution_not_retryable");
      }
      const requestKey = `${schedule.siteId}\0${input.requestId}`;
      const replay = retryRequests.get(requestKey);
      if (replay !== undefined) {
        if (
          replay.executionId !== input.executionId ||
          replay.actorId !== input.actorId
        ) {
          throw new BlogPostOperationError("idempotency_key_conflict");
        }
        return { ...replay.lease, replayed: true };
      }
      if (!input.approvalAuthorityValid) {
        throw new BlogPostOperationError("approval_stale");
      }
      if (
        (
          input.retryKind === "scheduler" &&
          (
            (
              existing.state !== "claimed" &&
              existing.state !== "unknown"
            ) ||
            existing.leaseExpiresAt > input.updatedAt
          )
        ) ||
        (
          input.retryKind === "human" &&
          existing.state !== "failed" &&
          existing.state !== "blocked"
        )
      ) {
        throw new BlogPostOperationError("execution_not_retryable");
      }
      const retried = {
        ...existing,
        attempt: existing.attempt + 1,
        attemptActorId: input.actorId,
        attemptRequestId: input.requestId,
        state: "claimed" as const,
        detail: null,
        leaseToken: input.leaseToken,
        leaseExpiresAt: input.leaseExpiresAt,
        updatedAt: input.updatedAt,
      };
      executions.set(input.executionId, retried);
      schedules.set(existing.scheduleId, {
        ...schedule,
        state: "claimed",
        detail: null,
      });
      const key = postKey(schedule.siteId, schedule.postId);
      const post = posts.get(key);
      if (post !== undefined) {
        posts.set(key, {
          ...post,
          workflowState: "executing",
        });
      }
      const lease = {
        siteId: schedule.siteId,
        postId: schedule.postId,
        execution: publicExecution(retried),
        leaseToken: input.leaseToken,
      };
      retryRequests.set(requestKey, {
        executionId: input.executionId,
        actorId: input.actorId,
        lease,
      });
      return lease;
    },
    async recordExecutionOutcome(input) {
      const existing = executions.get(input.executionId);
      if (existing === undefined) {
        throw new BlogPostOperationError("execution_not_found");
      }
      const schedule = schedules.get(existing.scheduleId);
      if (schedule === undefined) {
        throw new BlogPostOperationError("execution_not_found");
      }
      const requestKey = `${schedule.siteId}\0${input.outcomeId}`;
      const replay = executionOutcomeRequests.get(requestKey);
      if (replay !== undefined) {
        if (
          replay.executionId !== input.executionId ||
          replay.attempt !== input.attempt ||
          replay.outcome !== input.outcome ||
          replay.detail !== input.detail
        ) {
          throw new BlogPostOperationError("idempotency_key_conflict");
        }
        return replay.result;
      }
      if (existing.state === "completed") {
        return publicExecution(existing);
      }
      if (
        existing.leaseToken !== input.leaseToken ||
        existing.attempt !== input.attempt ||
        existing.leaseExpiresAt <= input.updatedAt
      ) {
        throw new BlogPostOperationError("execution_lease_lost");
      }
      const updated = Object.freeze({
        ...existing,
        state: input.outcome,
        detail: input.detail,
        leaseExpiresAt: input.updatedAt,
        updatedAt: input.updatedAt,
      });
      executions.set(existing.executionId, updated);
      schedules.set(existing.scheduleId, {
        ...schedule,
        state: input.outcome,
        detail: input.detail,
      });
      const key = postKey(schedule.siteId, schedule.postId);
      const post = posts.get(key);
      if (post !== undefined) {
        posts.set(key, {
          ...post,
          workflowState:
            input.outcome === "completed" ? "editing" : "failed",
        });
      }
      const result = publicExecution(updated);
      executionOutcomeRequests.set(requestKey, {
        executionId: input.executionId,
        attempt: input.attempt,
        outcome: input.outcome,
        detail: input.detail,
        result,
      });
      return result;
    },
    async archive(input) {
      const requestKey =
        `${input.siteId}\0${input.idempotencyKey}`;
      const replay = archiveRequests.get(requestKey);
      if (replay !== undefined) {
        if (
          replay.actorId !== input.actorId ||
          replay.selectedPostRevisionId !== input.selectedPostRevisionId ||
          replay.result.postId !== input.postId
        ) {
          throw new BlogPostOperationError("idempotency_key_conflict");
        }
        return replay.result;
      }
      const key = postKey(input.siteId, input.postId);
      const post = posts.get(key);
      if (post === undefined) {
        throw new BlogPostOperationError("post_not_found");
      }
      if (post.collectionState !== "active") {
        throw new BlogPostOperationError("post_already_archived");
      }
      if (
        !revisionHistory
          .get(key)
          ?.has(input.selectedPostRevisionId)
      ) {
        throw new BlogPostOperationError("revision_not_found");
      }
      await store.cancelSchedulesForSuccessor({
        siteId: input.siteId,
        postId: input.postId,
        workspaceId: post.workspaceId,
        contentRevision: Number.MAX_SAFE_INTEGER,
        occurredAt: input.occurredAt,
      });
      const withdrawalRequired = post.liveRevisionId !== null;
      const updated: BlogPostOperationalState = {
        ...post,
        collectionState: withdrawalRequired ? "archiving" : "archived",
        version: post.version + 1,
      };
      posts.set(key, updated);
      const result = Object.freeze({
        ...updated,
        selectedPostRevisionId: input.selectedPostRevisionId,
        withdrawalRequired,
      });
      archiveRequests.set(requestKey, {
        actorId: input.actorId,
        selectedPostRevisionId: input.selectedPostRevisionId,
        result,
      });
      await store.recordAudit({
        siteId: input.siteId,
        postId: input.postId,
        actorId: input.actorId,
        commandType: "blog.post.archive",
        requestId: input.idempotencyKey,
        outcome: "accepted",
        reasonCode: "accepted",
        beforeState: post,
        afterState: updated,
        occurredAt: input.occurredAt,
      });
      return result;
    },
    async confirmArchiveWithdrawal(input) {
      const key = postKey(input.siteId, input.postId);
      const post = posts.get(key);
      if (post === undefined) {
        throw new BlogPostOperationError("post_not_found");
      }
      if (post.collectionState !== "archiving") {
        throw new BlogPostOperationError("post_not_archiving");
      }
      if (withdrawalPublications.get(key) !== input.publicationId) {
        throw new BlogPostOperationError(
          "archive_withdrawal_not_verified",
        );
      }
      const archived: BlogPostOperationalState = {
        ...post,
        collectionState: "archived",
        liveRevisionId: null,
        version: post.version + 1,
      };
      posts.set(key, archived);
      return archived;
    },
    async bindArchiveWithdrawal(input) {
      const key = postKey(input.siteId, input.postId);
      const post = posts.get(key);
      if (post?.collectionState !== "archiving") {
        throw new BlogPostOperationError("post_not_archiving");
      }
      if (!withdrawalDrafts.has(key)) {
        throw new BlogPostOperationError("archive_publication_mismatch");
      }
      const existing = withdrawalPublications.get(key);
      if (existing !== undefined && existing !== input.publicationId) {
        throw new BlogPostOperationError("archive_publication_mismatch");
      }
      withdrawalPublications.set(key, input.publicationId);
      if (input.acceptedContinuation !== undefined) {
        await store.recordAudit({
          siteId: input.siteId,
          postId: input.postId,
          actorId: input.acceptedContinuation.actorId,
          commandType: "blog.post.archive.withdrawal.continue",
          requestId: input.acceptedContinuation.requestId,
          outcome: "accepted",
          reasonCode: "accepted",
          beforeState: input.acceptedContinuation.beforeState,
          afterState: input.acceptedContinuation.afterState,
          occurredAt: input.occurredAt,
        });
      }
    },
    async bindArchiveWithdrawalDraft(input) {
      const key = postKey(input.siteId, input.postId);
      const post = posts.get(key);
      if (post?.collectionState !== "archiving") {
        throw new BlogPostOperationError("post_not_archiving");
      }
      const existing = withdrawalDrafts.get(key);
      if (
        existing !== undefined &&
        (
          existing.workspaceId !== input.workspaceId ||
          existing.contentRevision !== input.contentRevision
        )
      ) {
        throw new BlogPostOperationError("idempotency_key_conflict");
      }
      withdrawalDrafts.set(key, {
        workspaceId: input.workspaceId,
        contentRevision: input.contentRevision,
      });
    },
    async grantArchiveWithdrawalRecoveryAccess(input) {
      if (!humanActorIds.has(input.actorId)) {
        throw new BlogPostOperationError("human_authority_required");
      }
      await store.recordAudit({
        siteId: input.siteId,
        postId: input.postId,
        actorId: input.actorId,
        commandType: "blog.post.archive.withdrawal.recover_access",
        requestId: input.requestId,
        outcome: "accepted",
        reasonCode: "accepted",
        beforeState: posts.get(postKey(input.siteId, input.postId)) ?? null,
        afterState: {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          archiveRequestId: input.archiveRequestId,
        },
        occurredAt: input.occurredAt,
      });
    },
    async restore(input) {
      const requestKey = `${input.siteId}\0${input.idempotencyKey}`;
      const replay = restoreRequests.get(requestKey);
      if (replay !== undefined) {
        if (
          replay.actorId !== input.actorId ||
          replay.selectedPostRevisionId !== input.selectedPostRevisionId ||
          replay.result.postId !== input.postId
        ) {
          throw new BlogPostOperationError("idempotency_key_conflict");
        }
        return replay.result;
      }
      const key = postKey(input.siteId, input.postId);
      const post = posts.get(key);
      if (post === undefined) {
        throw new BlogPostOperationError("post_not_found");
      }
      if (post.collectionState !== "archived") {
        throw new BlogPostOperationError("post_not_archived");
      }
      if (input.provenance === undefined) {
        throw new BlogPostOperationError("restore_provenance_required");
      }
      if (
        !revisionHistory
          .get(key)
          ?.has(input.selectedPostRevisionId)
      ) {
        throw new BlogPostOperationError("revision_not_found");
      }
      const restored = Object.freeze({
        ...post,
        workspaceId: input.provenance.workspaceId,
        contentRevision: input.provenance.contentRevision,
        postRevision: post.postRevision + 1,
        postRevisionId: input.provenance.restoredPostRevisionId,
        collectionState: "active" as const,
        liveRevisionId: null,
        version: post.version + 1,
        targetVisibility: "unpublished" as const,
        sourcePostRevisionId: input.selectedPostRevisionId,
      });
      posts.set(key, restored);
      const history = revisionHistory.get(key) ?? new Set<string>();
      history.add(input.provenance.restoredPostRevisionId);
      revisionHistory.set(key, history);
      restoreRequests.set(requestKey, {
        actorId: input.actorId,
        selectedPostRevisionId: input.selectedPostRevisionId,
        result: restored,
      });
      await store.recordAudit({
        siteId: input.siteId,
        postId: input.postId,
        actorId: input.actorId,
        commandType: "blog.post.restore",
        requestId: input.idempotencyKey,
        outcome: "accepted",
        reasonCode: "accepted",
        beforeState: post,
        afterState: restored,
        occurredAt: input.occurredAt,
      });
      return restored;
    },
    async recordRestoreProvenance(input) {
      restoreProvenance.push(input);
    },
    async claimRestore(input) {
      const post = posts.get(postKey(input.siteId, input.postId));
      if (post?.collectionState !== "archived") {
        throw new BlogPostOperationError("post_not_archived");
      }
    },
    async recordAudit(event) {
      if (
        !auditEvents.some(
          (existing) =>
            existing.siteId === event.siteId &&
            existing.commandType === event.commandType &&
            existing.requestId === event.requestId &&
            existing.outcome === event.outcome,
        )
      ) {
        auditEvents.push(event);
      }
    },
    async countPostRevisionHistory(siteId, postId) {
      return revisionHistory.get(postKey(siteId, postId))?.size ?? 0;
    },
  };
  return Object.freeze(store);
}
