import {
  isSiteDefinition,
  serializeSiteDefinitionRichTextForPublication,
  type SiteDefinition,
  type SiteDefinitionSchemaVersion,
} from "@foundry/site-definition";

import {
  isValidContentMutationIdempotencyKey,
  type ContentActorId,
  type ContentRevision,
  type ContentWorkspaceId,
} from "./content-revisions";
import { canonicalJson } from "./deterministic-hash";
import type { HumanMembershipId } from "./human-access";

export const publishedSiteDefinitionPath =
  "packages/site-definition/src/published-site.json";
export const contentSerializationVersion =
  "foundry.site-publication-artifacts.v2";
export type ContentSerializationVersion =
  | "foundry.site-definition.canonical-json.v1"
  | typeof contentSerializationVersion;
const publicationLeaseDurationMs = 5 * 60 * 1_000;

declare const contentApprovalIdBrand: unique symbol;
export type ContentApprovalId = string & {
  readonly [contentApprovalIdBrand]: "ContentApprovalId";
};

declare const contentPublicationIdBrand: unique symbol;
export type ContentPublicationId = string & {
  readonly [contentPublicationIdBrand]: "ContentPublicationId";
};

export function createContentApprovalId(value: string): ContentApprovalId {
  if (!/^approval_[a-f0-9]{32}$/u.test(value)) {
    throw new TypeError("content_approval_id_invalid");
  }
  return value as ContentApprovalId;
}

export function createContentPublicationId(
  value: string,
): ContentPublicationId {
  if (!/^publish_[a-f0-9]{32}$/u.test(value)) {
    throw new TypeError("content_publication_id_invalid");
  }
  return value as ContentPublicationId;
}

export type ContentPublicationChannel = "site";

export type ContentApprovalFingerprint = Readonly<{
  value: string;
  channel: ContentPublicationChannel;
  channelConfigurationHash: string;
  contentHash: string;
  designHash: string;
  schemaVersion: SiteDefinitionSchemaVersion;
  rendererVersion: string;
  productionBase: string;
  artifactHash: string;
  serializationVersion: ContentSerializationVersion;
}>;

export type ContentPublicationArtifact = Readonly<{
  path:
    | typeof publishedSiteDefinitionPath
    | `content/rich-text/${string}.md`;
  bytes: string;
}>;

export type ContentApproval = Readonly<{
  id: ContentApprovalId;
  workspaceId: ContentWorkspaceId;
  revision: number;
  fingerprint: ContentApprovalFingerprint;
  approvedBy: HumanMembershipId;
  approvedAt: string;
  invalidatedAt: string | null;
}>;

export const contentPublicationStatuses = [
  "requested",
  "committed",
  "building",
  "deployed",
  "verified-live",
  "blocked",
  "failed",
  "unknown",
] as const;

export type ContentPublicationStatus =
  (typeof contentPublicationStatuses)[number];

export type ContentPublication = Readonly<{
  id: ContentPublicationId;
  workspaceId: ContentWorkspaceId;
  revision: number;
  approvalId: ContentApprovalId;
  fingerprint: string;
  idempotencyKey: string;
  requestedBy: HumanMembershipId;
  contributors: ReadonlyArray<ContentActorId>;
  expectedHead: string;
  status: ContentPublicationStatus;
  commitSha: string | null;
  deploymentId: string | null;
  deploymentRequestedAt: string | null;
  detail: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  requestedAt: string;
  updatedAt: string;
}>;

export type ContentPublicationEvent = Readonly<{
  status: ContentPublicationStatus;
  detail: string | null;
  commitSha: string | null;
  deploymentId: string | null;
  approvalFingerprint: string;
  occurredAt: string;
}>;

export type ContentPublicationHistoryEntry = Readonly<{
  publication: ContentPublication;
  approval: ContentApproval;
  events: ReadonlyArray<ContentPublicationEvent>;
}>;

export type ContentPublishedRevisionReader = Readonly<{
  readPublishedArtifact(input: {
    commitSha: string;
    path: ContentPublicationArtifact["path"];
  }): Promise<string | null>;
}>;

export type RestoredContentDraft = Readonly<{
  workspaceId: ContentWorkspaceId;
  revision: number;
  sourcePublicationId: ContentPublicationId;
}>;

export type ContentPublicationDraftRestorer = Readonly<{
  restore(input: {
    sourcePublicationId: ContentPublicationId;
    workspaceId: ContentWorkspaceId;
    definition: SiteDefinition;
    actorId: ContentActorId;
    idempotencyKey: string;
  }): Promise<RestoredContentDraft>;
}>;

export type ContentPublicationCommandIdentity = Readonly<
  Pick<
    ContentPublication,
    | "workspaceId"
    | "revision"
    | "approvalId"
    | "fingerprint"
    | "requestedBy"
  >
>;

export function serializeContentPublicationCommandIdentity(
  publication: ContentPublicationCommandIdentity,
): string {
  return canonicalJson({
    approvalId: publication.approvalId,
    fingerprint: publication.fingerprint,
    requestedBy: publication.requestedBy,
    revision: publication.revision,
    workspaceId: publication.workspaceId,
  });
}

export function assertContentPublicationIdempotency(
  recordedIdentity: string,
  publication: ContentPublicationCommandIdentity,
): void {
  if (
    recordedIdentity !==
    serializeContentPublicationCommandIdentity(publication)
  ) {
    throw new ContentPublicationIdempotencyError();
  }
}

export function serializeContentRestoreIdentity(input: {
  sourcePublicationId: ContentPublicationId;
  workspaceId: ContentWorkspaceId;
  actorId: ContentActorId;
  idempotencyKey: string;
}) {
  return canonicalJson(input);
}

export type ContentPublicationClaim =
  | Readonly<{
      state: "claimed" | "replayed";
      publication: ContentPublication;
    }>
  | Readonly<{
      state: "blocked";
      publication: ContentPublication;
    }>;

export type ContentPublicationStore = Readonly<{
  saveApproval(approval: ContentApproval): Promise<ContentApproval>;
  findApproval(id: ContentApprovalId): Promise<ContentApproval | null>;
  invalidateApproval(input: {
    approvalId: ContentApprovalId;
    invalidatedAt: string;
    reason: "production_changed";
  }): Promise<ContentApproval | null>;
  claimPublication(
    publication: ContentPublication,
  ): Promise<ContentPublicationClaim>;
  hasPublicationLease(input: {
    publicationId: ContentPublicationId;
    leaseToken: string;
    now: string;
  }): Promise<boolean>;
  renewPublicationLease(input: {
    publicationId: ContentPublicationId;
    leaseToken: string;
    now: string;
    leaseExpiresAt: string;
    expectedStatus?: "requested" | "committed";
    expectedDetail?: string;
    expectedDeploymentId?: string;
  }): Promise<boolean>;
  updatePublication(
    publication: ContentPublication,
    options?: {
      expectedLeaseToken?: string;
      expectedLeaseValidAt?: string;
      expectedStatus?: ContentPublicationStatus;
      expectedUpdatedAt?: string;
    },
  ): Promise<ContentPublication>;
  findPublication(id: ContentPublicationId): Promise<ContentPublication | null>;
  findPublicationByIdempotency(input: {
    workspaceId: ContentWorkspaceId;
    idempotencyKey: string;
  }): Promise<ContentPublication | null>;
  findActivePublication(): Promise<ContentPublication | null>;
  findLatestPublication(
    workspaceId: ContentWorkspaceId,
  ): Promise<ContentPublication | null>;
  claimRestoreIdentity(input: {
    sourcePublicationId: ContentPublicationId;
    workspaceId: ContentWorkspaceId;
    actorId: ContentActorId;
    idempotencyKey: string;
  }): Promise<void>;
  listPublicationHistory(limit?: number): Promise<
    ReadonlyArray<ContentPublicationHistoryEntry>
  >;
}>;

export type ContentPublicationRevisionRepository = Readonly<{
  getRevision(
    workspaceId: ContentWorkspaceId,
    revision: number,
  ): Promise<ContentRevision | null>;
  getCurrent(workspaceId: ContentWorkspaceId): Promise<ContentRevision>;
  isCurrent(revision: ContentRevision): Promise<boolean>;
  listContributors(
    workspaceId: ContentWorkspaceId,
    revision: number,
  ): Promise<ReadonlyArray<ContentActorId>>;
}>;

export type PublicationCommitResult =
  | Readonly<{ state: "committed"; commitSha: string }>
  | Readonly<{ state: "blocked"; detail: string }>
  | Readonly<{ state: "failed"; detail: string }>
  | Readonly<{ state: "unknown"; detail: string }>;

export type ContentPublisher = Readonly<{
  getChannelConfigurationHash(): Promise<string>;
  getProductionHead(): Promise<string>;
  isReleaseLive(expected: {
    commitSha: string;
    contentHash: string;
    schemaVersion: SiteDefinitionSchemaVersion;
  }): Promise<boolean>;
  createCommit(input: {
    publishId: ContentPublicationId;
    workspaceId: ContentWorkspaceId;
    revision: number;
    approvedBy: HumanMembershipId;
    contributors: ReadonlyArray<ContentActorId>;
    contentHash: string;
    expectedHead: string;
    artifacts: ReadonlyArray<ContentPublicationArtifact>;
    artifactHash: string;
    message: string;
    assertLease(): Promise<boolean>;
  }): Promise<PublicationCommitResult>;
  reconcileCommit(input: {
    publishId: ContentPublicationId;
    candidateCommitSha?: string;
    expectedHead: string;
    artifacts: ReadonlyArray<ContentPublicationArtifact>;
    artifactHash: string;
    contentHash: string;
    message: string;
  }): Promise<
    | Readonly<{ state: "committed"; commitSha: string }>
    | Readonly<{ state: "not-found" | "unknown" }>
  >;
  retryReference(input: {
    publishId: ContentPublicationId;
    candidateCommitSha: string;
    expectedHead: string;
    artifacts: ReadonlyArray<ContentPublicationArtifact>;
    artifactHash: string;
    assertLease(): Promise<boolean>;
  }): Promise<PublicationCommitResult>;
  getDeploymentStatus(
    commitSha: string,
    deploymentId?: string,
  ): Promise<"requested" | "building" | "deployed" | "failed" | "unknown">;
  retryDeployment(input: {
    commitSha: string;
    assertDispatch(): Promise<boolean>;
  }): Promise<
    | Readonly<{ state: "requested"; deploymentId: string }>
    | Readonly<{ state: "blocked"; detail: "deployment_retry_claim_lost" }>
    | Readonly<{ state: "failed" | "unknown" }>
  >;
}>;

function reconciliationCandidate(detail: string | null): string | undefined {
  const candidate = detail?.match(
    /^git_reference_(?:result_unknown|not_advanced):([a-f0-9]{40}|[a-f0-9]{64})$/u,
  )?.[1];
  return candidate;
}

export function contentPublicationHasUnresolvedGitOutcome(publication: {
  commitSha: string | null;
  detail: string | null;
}): boolean {
  return (
    publication.commitSha === null &&
    (reconciliationCandidate(publication.detail) !== undefined ||
      [
        "git_commit_not_found",
        "git_reconciliation_timeout",
        "git_result_unknown",
        "publication_lease_expired",
      ].includes(publication.detail ?? ""))
  );
}

const deploymentRetryDispatchEvidence = new Set([
  "deployment_retry_dispatching",
  "deployment_retry_reconciled",
  "deployment_retry_requested",
  "deployment_retry_result_unknown",
  "deployment_retry_timeout",
]);

function deploymentRetryDispatchWasAttempted(publication: {
  deploymentRequestedAt: string | null;
  deploymentId: string | null;
  detail: string | null;
}) {
  return (
    publication.deploymentRequestedAt !== null &&
    (deploymentRetryDispatchEvidence.has(publication.detail ?? "") ||
      (publication.deploymentId !== null &&
        !publication.deploymentId.startsWith("retry-dispatch:")))
  );
}

export class ContentApprovalInvalidError extends Error {
  readonly code:
    | "revision_not_current"
    | "revision_stale"
    | "approval_not_found"
    | "approval_invalidated"
    | "approval_stale"
    | "production_head_moved"
    | "release_marker_mismatch";

  constructor(code: ContentApprovalInvalidError["code"]) {
    super(code);
    this.name = "ContentApprovalInvalidError";
    this.code = code;
  }
}

export class ContentPublicationIdempotencyError extends Error {
  constructor() {
    super("content_publication_idempotency_key_conflict");
    this.name = "ContentPublicationIdempotencyError";
  }
}

export class ContentPublicationValidationError extends Error {
  readonly code:
    | "preview_confirmation_required"
    | "idempotency_key_invalid"
    | "production_base_invalid"
    | "publication_no_changes"
    | "deployment_retry_not_available"
    | "deployment_retry_head_moved"
    | "deployment_retry_release_marker_mismatch"
    | "deployment_retry_in_progress"
    | "restore_source_not_found"
    | "restore_source_not_live"
    | "restore_artifact_unavailable"
    | "restore_artifact_mismatch"
    | "restore_not_configured";

  constructor(code: ContentPublicationValidationError["code"]) {
    super(code);
    this.name = "ContentPublicationValidationError";
    this.code = code;
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function serializePublishedSiteDefinition(
  definition: SiteDefinition,
): string {
  return `${canonicalJson(definition)}\n`;
}

export function serializeContentPublicationArtifacts(
  definition: SiteDefinition,
): ReadonlyArray<ContentPublicationArtifact> {
  return [
    {
      path: publishedSiteDefinitionPath,
      bytes: serializePublishedSiteDefinition(definition),
    },
    ...serializeSiteDefinitionRichTextForPublication(definition).map(
      ({ filePath, markdown }) => ({
        path: filePath,
        bytes: markdown,
      }),
    ),
  ];
}

export async function hashContentPublicationArtifacts(
  artifacts: ReadonlyArray<ContentPublicationArtifact>,
): Promise<string> {
  const sorted = [...artifacts].sort(({ path: left }, { path: right }) =>
    left.localeCompare(right),
  );
  if (
    sorted.length === 0 ||
    !sorted.some(({ path }) => path === publishedSiteDefinitionPath) ||
    sorted.some(
      (artifact, index) =>
        (artifact.path === publishedSiteDefinitionPath &&
          artifact.bytes.length === 0) ||
        (artifact.path !== publishedSiteDefinitionPath &&
          !/^content\/rich-text\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.md$/u.test(
            artifact.path,
          )) ||
        (index > 0 && sorted[index - 1]?.path === artifact.path),
    )
  ) {
    throw new TypeError("content_publication_artifacts_invalid");
  }
  const manifest = await Promise.all(
    sorted.map(async ({ path, bytes }) => ({
      path,
      byteLength: new TextEncoder().encode(bytes).byteLength,
      sha256: await sha256(bytes),
    })),
  );
  return sha256(canonicalJson(manifest));
}

export function hashPublishedSiteDefinition(
  definition: SiteDefinition,
): Promise<string> {
  return sha256(canonicalJson(definition));
}

function designProjection(definition: SiteDefinition) {
  return {
    definitionVersion: definition.definitionVersion,
    design: definition.design,
    siteId: definition.site.id,
    navigation: definition.site.navigation.map(({ id, href }) => ({
      id,
      href,
    })),
    pageId: definition.home.id,
    sections: definition.home.sections.map(({ id, type, variant }) => ({
      id,
      type,
      variant,
    })),
  };
}

export async function createContentApprovalFingerprint(
  revision: ContentRevision,
  channelConfigurationHash: string,
  channel: ContentPublicationChannel = "site",
): Promise<ContentApprovalFingerprint> {
  if (revision.inputs.schemaVersion !== revision.definition.schemaVersion) {
    throw new ContentApprovalInvalidError("revision_stale");
  }
  if (!isSiteDefinition(revision.definition)) {
    throw new ContentApprovalInvalidError("revision_stale");
  }
  const artifactHash = await hashContentPublicationArtifacts(
    serializeContentPublicationArtifacts(revision.definition),
  );
  const canonicalDefinitionHash = await sha256(
    canonicalJson(revision.definition),
  );
  if (
    canonicalDefinitionHash !== revision.inputs.contentHash ||
    revision.inputs.schemaVersion !== revision.definition.schemaVersion
  ) {
    throw new ContentApprovalInvalidError("revision_stale");
  }
  const designHash = await sha256(canonicalJson(designProjection(
    revision.definition,
  )));
  const binding = {
    channel,
    channelConfigurationHash,
    contentHash: revision.inputs.contentHash,
    designHash,
    schemaVersion: revision.inputs.schemaVersion,
    rendererVersion: revision.inputs.rendererVersion,
    productionBase: revision.inputs.productionBase,
    artifactHash,
    serializationVersion: contentSerializationVersion,
  } as const;
  return {
    ...binding,
    value: await sha256(canonicalJson(binding)),
  };
}

export function parseProductionBase(value: string): Readonly<{
  commitSha: string;
  contentHash: string;
}> {
  const match =
    /^git:([a-f0-9]{40}|[a-f0-9]{64})@content:([a-f0-9]{64})$/u.exec(value);
  if (match === null) {
    throw new ContentPublicationValidationError("production_base_invalid");
  }
  return { commitSha: match[1]!, contentHash: match[2]! };
}

function randomHexId(prefix: "approval" | "publish") {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function commitMessage(input: {
  publication: ContentPublication;
  approval: ContentApproval;
}) {
  return [
    `Publish site revision ${input.publication.revision}`,
    "",
    `Foundry-Publish-Id: ${input.publication.id}`,
    `Foundry-Workspace: ${input.publication.workspaceId}`,
    `Foundry-Revision: ${input.publication.revision}`,
    `Foundry-Approved-By: ${input.approval.approvedBy}`,
    `Foundry-Contributors: ${input.publication.contributors.join(",")}`,
    `Foundry-Content-Hash: ${input.approval.fingerprint.contentHash}`,
  ].join("\n");
}

function nextPublication(
  publication: ContentPublication,
  update: Readonly<{
    status: ContentPublicationStatus;
    commitSha?: string | null;
    deploymentId?: string | null;
    deploymentRequestedAt?: string | null;
    detail?: string | null;
    leaseToken?: string | null;
    leaseExpiresAt?: string | null;
    updatedAt: string;
  }>,
): ContentPublication {
  return Object.freeze({
    ...publication,
    status: update.status,
    commitSha: update.commitSha ?? publication.commitSha,
    deploymentId:
      update.deploymentId === undefined
        ? publication.deploymentId
        : update.deploymentId,
    deploymentRequestedAt:
      update.deploymentRequestedAt === undefined
        ? publication.deploymentRequestedAt
        : update.deploymentRequestedAt,
    detail: update.detail === undefined ? publication.detail : update.detail,
    leaseToken:
      update.leaseToken === undefined
        ? publication.leaseToken
        : update.leaseToken,
    leaseExpiresAt:
      update.leaseExpiresAt === undefined
        ? publication.leaseExpiresAt
        : update.leaseExpiresAt,
    updatedAt: update.updatedAt,
  });
}

const activeStatuses = new Set<ContentPublicationStatus>([
  "requested",
  "committed",
  "building",
  "deployed",
  "unknown",
]);

const deploymentProgress: Readonly<
  Partial<Record<ContentPublicationStatus, number>>
> = {
  requested: 0,
  committed: 1,
  building: 2,
  deployed: 3,
  "verified-live": 4,
};
const deploymentSignalTimeoutMs = 15 * 60 * 1_000;
const deploymentDispatchTimeoutMs = 60 * 1_000;

export function createInMemoryContentPublicationStore(): ContentPublicationStore {
  const approvals = new Map<ContentApprovalId, ContentApproval>();
  const publications = new Map<ContentPublicationId, ContentPublication>();
  const events = new Map<
    ContentPublicationId,
    Array<ContentPublicationEvent>
  >();
  const restoreIdentities = new Map<ContentWorkspaceId, string>();

  function recordEvent(publication: ContentPublication) {
    const history = events.get(publication.id) ?? [];
    history.push({
      status: publication.status,
      detail: publication.detail,
      commitSha: publication.commitSha,
      deploymentId: publication.deploymentId,
      approvalFingerprint: publication.fingerprint,
      occurredAt: publication.updatedAt,
    });
    events.set(publication.id, history);
  }

  return {
    async saveApproval(approval) {
      const duplicate = [...approvals.values()].find(
        (candidate) =>
          candidate.workspaceId === approval.workspaceId &&
          candidate.revision === approval.revision &&
          candidate.fingerprint.value === approval.fingerprint.value &&
          candidate.approvedBy === approval.approvedBy &&
          candidate.invalidatedAt === null,
      );
      if (duplicate !== undefined) {
        return duplicate;
      }
      for (const [id, existing] of approvals) {
        if (
          existing.workspaceId === approval.workspaceId &&
          existing.invalidatedAt === null &&
          existing.id !== approval.id
        ) {
          approvals.set(id, {
            ...existing,
            invalidatedAt: approval.approvedAt,
          });
        }
      }
      approvals.set(approval.id, Object.freeze({ ...approval }));
      return approval;
    },
    async findApproval(id) {
      return approvals.get(id) ?? null;
    },
    async invalidateApproval({ approvalId, invalidatedAt }) {
      const approval = approvals.get(approvalId);
      if (approval === undefined) {
        return null;
      }
      if (approval.invalidatedAt !== null) {
        return approval;
      }
      const invalidated = Object.freeze({ ...approval, invalidatedAt });
      approvals.set(approvalId, invalidated);
      return invalidated;
    },
    async claimPublication(publication) {
      const replay = [...publications.values()].find(
        (candidate) =>
          candidate.workspaceId === publication.workspaceId &&
          candidate.idempotencyKey === publication.idempotencyKey,
      );
      if (replay !== undefined) {
        assertContentPublicationIdempotency(
          serializeContentPublicationCommandIdentity(replay),
          publication,
        );
        return { state: "replayed", publication: replay };
      }
      const active = [...publications.values()].find((candidate) =>
        activeStatuses.has(candidate.status),
      );
      if (active !== undefined) {
        const blocked = nextPublication(publication, {
          status: "blocked",
          detail: "publication_in_progress",
          updatedAt: publication.updatedAt,
        });
        publications.set(blocked.id, blocked);
        recordEvent(blocked);
        return { state: "blocked", publication: blocked };
      }
      publications.set(publication.id, publication);
      recordEvent(publication);
      return { state: "claimed", publication };
    },
    async hasPublicationLease({ publicationId, leaseToken, now }) {
      const publication = publications.get(publicationId);
      const approval =
        publication === undefined
          ? undefined
          : approvals.get(publication.approvalId);
      return (
        publication?.status === "requested" &&
        publication.leaseToken === leaseToken &&
        publication.leaseExpiresAt !== null &&
        publication.leaseExpiresAt > now &&
        approval?.invalidatedAt === null
      );
    },
    async renewPublicationLease({
      publicationId,
      leaseToken,
      now,
      leaseExpiresAt,
      expectedStatus = "requested",
      expectedDetail,
      expectedDeploymentId,
    }) {
      const publication = publications.get(publicationId);
      const approval =
        publication === undefined
          ? undefined
          : approvals.get(publication.approvalId);
      if (
        publication?.status !== expectedStatus ||
        publication.leaseToken !== leaseToken ||
        publication.leaseExpiresAt === null ||
        publication.leaseExpiresAt <= now ||
        approval?.invalidatedAt !== null ||
        (expectedDetail !== undefined &&
          publication.detail !== expectedDetail) ||
        (expectedDeploymentId !== undefined &&
          publication.deploymentId !== expectedDeploymentId)
      ) {
        return false;
      }
      publications.set(
        publicationId,
        nextPublication(publication, {
          status: publication.status,
          leaseExpiresAt,
          updatedAt: publication.updatedAt,
        }),
      );
      return true;
    },
    async updatePublication(publication, options) {
      const current = publications.get(publication.id);
      if (
        options?.expectedLeaseToken !== undefined &&
        (!(
          current?.status === "requested" ||
          (current?.status === "committed" &&
            current.detail === "deployment_retry_dispatching")
        ) ||
          current.leaseToken !== options.expectedLeaseToken ||
          (options.expectedLeaseValidAt !== undefined &&
            (current.leaseExpiresAt === null ||
              current.leaseExpiresAt <= options.expectedLeaseValidAt)))
      ) {
        return current ?? publication;
      }
      if (
        (options?.expectedStatus !== undefined &&
          current?.status !== options.expectedStatus) ||
        (options?.expectedUpdatedAt !== undefined &&
          current?.updatedAt !== options.expectedUpdatedAt)
      ) {
        return current ?? publication;
      }
      if (current?.status === "verified-live") {
        return current;
      }
      if (
        current !== undefined &&
        current.commitSha !== null &&
        publication.commitSha === null
      ) {
        return current;
      }
      publications.set(publication.id, Object.freeze({ ...publication }));
      recordEvent(publication);
      return publication;
    },
    async findPublication(id) {
      return publications.get(id) ?? null;
    },
    async findPublicationByIdempotency({ workspaceId, idempotencyKey }) {
      return (
        [...publications.values()].find(
          (publication) =>
            publication.workspaceId === workspaceId &&
            publication.idempotencyKey === idempotencyKey,
        ) ?? null
      );
    },
    async findActivePublication() {
      return (
        [...publications.values()].find((publication) =>
          activeStatuses.has(publication.status),
        ) ?? null
      );
    },
    async findLatestPublication(workspaceId) {
      return (
        [...publications.values()]
          .filter((publication) => publication.workspaceId === workspaceId)
          .sort((left, right) => {
            const leftIsActive = activeStatuses.has(left.status);
            const rightIsActive = activeStatuses.has(right.status);
            if (leftIsActive !== rightIsActive) {
              return leftIsActive ? -1 : 1;
            }
            const leftIsContender =
              left.status === "blocked" &&
              left.detail === "publication_in_progress";
            const rightIsContender =
              right.status === "blocked" &&
              right.detail === "publication_in_progress";
            if (leftIsContender !== rightIsContender) {
              return leftIsContender ? 1 : -1;
            }
            return right.requestedAt.localeCompare(left.requestedAt);
          })[0] ?? null
      );
    },
    async claimRestoreIdentity(input) {
      const identity = serializeContentRestoreIdentity(input);
      const recorded = restoreIdentities.get(input.workspaceId);
      if (recorded !== undefined && recorded !== identity) {
        throw new ContentPublicationIdempotencyError();
      }
      restoreIdentities.set(input.workspaceId, identity);
    },
    async listPublicationHistory(limit = 50) {
      const history: ContentPublicationHistoryEntry[] = [];
      for (const publication of [...publications.values()]
        .sort((left, right) =>
          right.requestedAt.localeCompare(left.requestedAt)
        )
        .slice(0, Math.min(Math.max(limit, 1), 100))) {
        const approval = approvals.get(publication.approvalId);
        if (approval !== undefined) {
          history.push({
            publication,
            approval,
            events: Object.freeze([...(events.get(publication.id) ?? [])]),
          });
        }
      }
      return history;
    },
  };
}

export function createContentPublicationApplication({
  store,
  revisions,
  publisher,
  publishedRevisions,
  draftRestorer,
  restoreSourcePublication,
  now = () => new Date().toISOString(),
}: {
  store: ContentPublicationStore;
  revisions: ContentPublicationRevisionRepository;
  publisher: ContentPublisher;
  publishedRevisions?: ContentPublishedRevisionReader;
  draftRestorer?: ContentPublicationDraftRestorer;
  restoreSourcePublication?: ContentPublication;
  now?: () => string;
}) {
  async function requireExactRevision(
    workspaceId: ContentWorkspaceId,
    revisionNumber: number,
  ) {
    const [selected, current] = await Promise.all([
      revisions.getRevision(workspaceId, revisionNumber),
      revisions.getCurrent(workspaceId),
    ]);
    if (
      selected === null ||
      current.revision !== revisionNumber ||
      current.inputs.contentHash !== selected.inputs.contentHash
    ) {
      throw new ContentApprovalInvalidError("revision_not_current");
    }
    if (!(await revisions.isCurrent(selected))) {
      throw new ContentApprovalInvalidError("revision_stale");
    }
    return selected;
  }

  async function requireApproval(
    approvalId: ContentApprovalId,
    actorId: HumanMembershipId,
  ) {
    const approval = await store.findApproval(approvalId);
    if (approval === null) {
      throw new ContentApprovalInvalidError("approval_not_found");
    }
    if (approval.invalidatedAt !== null) {
      throw new ContentApprovalInvalidError("approval_invalidated");
    }
    const revision = await requireExactRevision(
      approval.workspaceId,
      approval.revision,
    );
    const fingerprint = await createContentApprovalFingerprint(
      revision,
      await publisher.getChannelConfigurationHash(),
    );
    if (
      fingerprint.value !== approval.fingerprint.value ||
      approval.fingerprint.serializationVersion !==
        contentSerializationVersion
    ) {
      throw new ContentApprovalInvalidError("approval_stale");
    }
    if (actorId.trim() === "") {
      throw new ContentApprovalInvalidError("approval_not_found");
    }
    return { approval, revision };
  }

  async function approvedBaseIsLive(approval: ContentApproval) {
    const base = parseProductionBase(
      approval.fingerprint.productionBase,
    );
    return publisher.isReleaseLive({
      commitSha: base.commitSha,
      contentHash: base.contentHash,
      schemaVersion: approval.fingerprint.schemaVersion,
    });
  }

  async function invalidateForProductionChange(
    approval: ContentApproval,
  ) {
    await store.invalidateApproval({
      approvalId: approval.id,
      invalidatedAt: now(),
      reason: "production_changed",
    });
  }

  function commitReconciliationInput(
    publication: ContentPublication,
    approval: ContentApproval,
    revision: ContentRevision,
  ): Parameters<ContentPublisher["reconcileCommit"]>[0] {
    return {
      publishId: publication.id,
      expectedHead: publication.expectedHead,
      artifacts: serializeContentPublicationArtifacts(revision.definition),
      artifactHash: approval.fingerprint.artifactHash,
      contentHash: approval.fingerprint.contentHash,
      message: commitMessage({ publication, approval }),
    };
  }

  function createPublicationCommitLeaseGuard(input: {
    publication: ContentPublication;
    leaseToken: string;
    requestedBy: HumanMembershipId;
  }) {
    return async () => {
      let currentApproval: ContentApproval;
      try {
        ({ approval: currentApproval } = await requireApproval(
          input.publication.approvalId,
          input.requestedBy,
        ));
      } catch (error) {
        if (error instanceof ContentApprovalInvalidError) {
          return false;
        }
        throw error;
      }
      if (!(await approvedBaseIsLive(currentApproval))) {
        await invalidateForProductionChange(currentApproval);
        return false;
      }
      const leaseNow = now();
      return store.renewPublicationLease({
        publicationId: input.publication.id,
        leaseToken: input.leaseToken,
        now: leaseNow,
        leaseExpiresAt: new Date(
          new Date(leaseNow).getTime() + publicationLeaseDurationMs,
        ).toISOString(),
      });
    };
  }

  async function attemptAtomicPublicationCommit(input: {
    publication: ContentPublication;
    approval: ContentApproval;
    revision: ContentRevision;
    assertLease(): Promise<boolean>;
  }): Promise<PublicationCommitResult> {
    try {
      return await publisher.createCommit({
        publishId: input.publication.id,
        workspaceId: input.publication.workspaceId,
        revision: input.publication.revision,
        approvedBy: input.approval.approvedBy,
        contributors: input.publication.contributors,
        contentHash: input.approval.fingerprint.contentHash,
        expectedHead: input.publication.expectedHead,
        artifacts: serializeContentPublicationArtifacts(
          input.revision.definition,
        ),
        artifactHash: input.approval.fingerprint.artifactHash,
        message: commitMessage({
          publication: input.publication,
          approval: input.approval,
        }),
        assertLease: input.assertLease,
      });
    } catch {
      return {
        state: "unknown",
        detail: "git_result_unknown",
      };
    }
  }

  async function claimFailedPublicationRetry(
    publication: ContentPublication,
    detail: string,
  ) {
    if ((await store.findActivePublication()) !== null) {
      throw new ContentPublicationValidationError(
        "deployment_retry_in_progress",
      );
    }
    const retryRequestedAt = now();
    const leaseToken = crypto.randomUUID();
    let dispatching: ContentPublication;
    try {
      dispatching = await store.updatePublication(
        nextPublication(publication, {
          status: "requested",
          detail,
          leaseToken,
          leaseExpiresAt: new Date(
            new Date(retryRequestedAt).getTime() +
              publicationLeaseDurationMs,
          ).toISOString(),
          updatedAt: retryRequestedAt,
        }),
        {
          expectedStatus: "failed",
          expectedUpdatedAt: publication.updatedAt,
        },
      );
    } catch (error) {
      if ((await store.findActivePublication()) !== null) {
        throw new ContentPublicationValidationError(
          "deployment_retry_in_progress",
        );
      }
      throw error;
    }
    return { dispatching, leaseToken };
  }

  async function refreshPublication(publicationId: ContentPublicationId) {
    const publication = await store.findPublication(publicationId);
    if (publication === null) {
      return null;
    }
    if (
      publication.status === "verified-live" ||
      publication.status === "failed" ||
      publication.status === "blocked"
    ) {
      return publication;
    }
    const boundApproval = await store.findApproval(publication.approvalId);
    if (boundApproval === null) {
      return publication;
    }
    let channelFailure: "changed" | "unavailable" | null = null;
    try {
      if (
        boundApproval.fingerprint.channelConfigurationHash !==
        (await publisher.getChannelConfigurationHash())
      ) {
        channelFailure = "changed";
      }
    } catch {
      channelFailure = "unavailable";
    }
    if (channelFailure !== null) {
      const observedAt = now();
      const channelCheckStartedAt =
        publication.deploymentRequestedAt ?? publication.requestedAt;
      if (
        new Date(observedAt).getTime() -
          new Date(channelCheckStartedAt).getTime() >=
        deploymentSignalTimeoutMs
      ) {
        return store.updatePublication(
          nextPublication(publication, {
            status: "failed",
            detail:
              deploymentRetryDispatchWasAttempted(publication)
                ? "deployment_retry_timeout"
                : contentPublicationHasUnresolvedGitOutcome(publication)
                ? publication.detail
                : channelFailure === "changed"
                  ? "publication_channel_changed"
                  : "publication_channel_unavailable",
            updatedAt: observedAt,
          }),
          {
            expectedStatus: publication.status,
            expectedUpdatedAt: publication.updatedAt,
          },
        );
      }
      return publication;
    }
    if (publication.detail === "deployment_retry_dispatching") {
      const observedAt = now();
      const dispatchStartedAt =
        publication.deploymentRequestedAt ?? publication.updatedAt;
      if (
        new Date(observedAt).getTime() -
          new Date(dispatchStartedAt).getTime() <
        deploymentDispatchTimeoutMs
      ) {
        return publication;
      }
      return store.updatePublication(
        nextPublication(publication, {
          status: "unknown",
          deploymentId: null,
          detail: "deployment_retry_result_unknown",
          updatedAt: observedAt,
        }),
        {
          expectedStatus: publication.status,
          expectedUpdatedAt: publication.updatedAt,
        },
      );
    }
    let currentPublication = publication;
    let commitSha = publication.commitSha;
    if (
      commitSha === null &&
      publication.status === "requested" &&
      publication.leaseExpiresAt !== null &&
      publication.leaseExpiresAt > now()
    ) {
      return publication;
    }
    if (
      commitSha === null &&
      (publication.status === "unknown" ||
        publication.status === "requested")
    ) {
      const boundRevision = await revisions.getRevision(
        boundApproval.workspaceId,
        boundApproval.revision,
      );
      if (boundRevision === null) {
        return publication;
      }
      const reconciled = await publisher.reconcileCommit({
        ...commitReconciliationInput(
          publication,
          boundApproval,
          boundRevision,
        ),
        candidateCommitSha: reconciliationCandidate(publication.detail),
      });
      if (reconciled.state === "committed") {
        commitSha = reconciled.commitSha;
        currentPublication = await store.updatePublication(
          nextPublication(publication, {
            status: "committed",
            commitSha,
            detail: null,
            leaseToken: null,
            leaseExpiresAt: null,
            updatedAt: now(),
          }),
          {
            expectedStatus: publication.status,
            expectedUpdatedAt: publication.updatedAt,
          },
        );
        if (
          currentPublication.status !== "committed" ||
          currentPublication.commitSha !== commitSha
        ) {
          return currentPublication;
        }
      } else {
        const observedAt = now();
        const candidateCommitSha = reconciliationCandidate(
          publication.detail,
        );
        if (
          new Date(observedAt).getTime() -
            new Date(
              publication.deploymentRequestedAt ??
                publication.requestedAt,
            ).getTime() >=
          deploymentSignalTimeoutMs
        ) {
          return store.updatePublication(
            nextPublication(publication, {
              status: "failed",
              detail:
                candidateCommitSha !== undefined
                  ? `git_reference_not_advanced:${candidateCommitSha}`
                  : reconciled.state === "not-found"
                  ? publication.status === "requested"
                    ? "publication_lease_expired"
                    : "git_commit_not_found"
                  : "git_reconciliation_timeout",
              leaseToken: null,
              leaseExpiresAt: null,
              updatedAt: observedAt,
            }),
            {
              expectedStatus: publication.status,
              expectedUpdatedAt: publication.updatedAt,
            },
          );
        }
        return publication;
      }
    }
    if (commitSha === null) {
      return publication;
    }
    if (
      currentPublication.status === "unknown" &&
      currentPublication.detail === "deployment_retry_result_unknown"
    ) {
      const observedAt = now();
      const retryStartedAt =
        currentPublication.deploymentRequestedAt ??
        currentPublication.updatedAt;
      const approval = await store.findApproval(
        currentPublication.approvalId,
      );
      if (approval !== null) {
        try {
          if (
            await publisher.isReleaseLive({
              commitSha,
              contentHash: approval.fingerprint.contentHash,
              schemaVersion: approval.fingerprint.schemaVersion,
            })
          ) {
            return store.updatePublication(
              nextPublication(currentPublication, {
                status: "verified-live",
                detail: null,
                updatedAt: observedAt,
              }),
              {
                expectedStatus: currentPublication.status,
                expectedUpdatedAt: currentPublication.updatedAt,
              },
            );
          }
        } catch {
          // Marker unavailability remains uncertain until the bounded deadline.
        }
      }
      return new Date(observedAt).getTime() -
        new Date(retryStartedAt).getTime() >=
        deploymentSignalTimeoutMs
        ? store.updatePublication(
            nextPublication(currentPublication, {
              status: "failed",
              detail: "deployment_retry_timeout",
              updatedAt: observedAt,
            }),
            {
              expectedStatus: currentPublication.status,
              expectedUpdatedAt: currentPublication.updatedAt,
            },
          )
        : currentPublication;
    }
    const deployment = await publisher.getDeploymentStatus(
      commitSha,
      currentPublication.deploymentId ?? undefined,
    );
    const observedAt = now();
    const timedOut =
      new Date(observedAt).getTime() -
        new Date(
          currentPublication.deploymentRequestedAt ??
            currentPublication.requestedAt,
        ).getTime() >=
      deploymentSignalTimeoutMs;
    const manualDispatchFenced =
      deploymentRetryDispatchWasAttempted(currentPublication);
    const preserveManualDispatchFence = (
      detail: string | null,
      failed = false,
    ) =>
      manualDispatchFenced
        ? failed
          ? "deployment_retry_timeout"
          : "deployment_retry_reconciled"
        : detail;
    const update = (
      status: ContentPublicationStatus,
      detail: string | null,
    ) =>
      store.updatePublication(
        nextPublication(currentPublication, {
          status,
          commitSha,
          detail,
          updatedAt: observedAt,
        }),
        {
          expectedStatus: currentPublication.status,
          expectedUpdatedAt: currentPublication.updatedAt,
        },
      );

    if (
      deployment === "deployed" ||
      currentPublication.status === "deployed"
    ) {
      const approval = await store.findApproval(currentPublication.approvalId);
      if (approval === null) {
        return update(
          timedOut ? "failed" : "unknown",
          preserveManualDispatchFence(
            "approval_record_missing",
            timedOut,
          ),
        );
      }
      let live: boolean;
      try {
        live = await publisher.isReleaseLive({
          commitSha,
          contentHash: approval.fingerprint.contentHash,
          schemaVersion: approval.fingerprint.schemaVersion,
        });
      } catch {
        return update(
          timedOut ? "failed" : "deployed",
          preserveManualDispatchFence(
            timedOut
              ? "release_marker_timeout"
              : "release_marker_unavailable",
            timedOut,
          ),
        );
      }
      if (live) {
        return update("verified-live", null);
      }
      return update(
        timedOut ? "failed" : "deployed",
        preserveManualDispatchFence(
          timedOut ? "release_marker_timeout" : "release_marker_pending",
          timedOut,
        ),
      );
    }
    if (deployment === "failed") {
      return update(
        "failed",
        preserveManualDispatchFence("cloudflare_build_failed", true),
      );
    }
    if (timedOut && activeStatuses.has(currentPublication.status)) {
      return update(
        "failed",
        preserveManualDispatchFence("deployment_signal_timeout", true),
      );
    }
    if (deployment === "unknown") {
      return currentPublication;
    }
    const currentProgress = deploymentProgress[currentPublication.status];
    const nextProgress = deploymentProgress[deployment];
    if (
      currentProgress !== undefined &&
      nextProgress !== undefined &&
      nextProgress < currentProgress
    ) {
      return currentPublication;
    }
    return update(
      deployment,
      preserveManualDispatchFence(null),
    );
  }

  return Object.freeze({
    commands: Object.freeze({
      async approve(input: {
        workspaceId: ContentWorkspaceId;
        revision: number;
        approvedBy: HumanMembershipId;
        previewConfirmed: boolean;
      }) {
        if (!input.previewConfirmed) {
          throw new ContentPublicationValidationError(
            "preview_confirmation_required",
          );
        }
        const revision = await requireExactRevision(
          input.workspaceId,
          input.revision,
        );
        const approvedAt = now();
        return store.saveApproval({
          id: createContentApprovalId(
            randomHexId("approval"),
          ),
          workspaceId: input.workspaceId,
          revision: input.revision,
          fingerprint: await createContentApprovalFingerprint(
            revision,
            await publisher.getChannelConfigurationHash(),
          ),
          approvedBy: input.approvedBy,
          approvedAt,
          invalidatedAt: null,
        });
      },
      async publish(input: {
        workspaceId: ContentWorkspaceId;
        approvalId: ContentApprovalId;
        requestedBy: HumanMembershipId;
        idempotencyKey: string;
      }) {
        if (!isValidContentMutationIdempotencyKey(input.idempotencyKey)) {
          throw new ContentPublicationValidationError(
            "idempotency_key_invalid",
          );
        }
        const recordedApproval = await store.findApproval(input.approvalId);
        if (recordedApproval !== null) {
          if (recordedApproval.workspaceId !== input.workspaceId) {
            throw new ContentApprovalInvalidError("approval_not_found");
          }
          const replay = await store.findPublicationByIdempotency({
            workspaceId: recordedApproval.workspaceId,
            idempotencyKey: input.idempotencyKey,
          });
          if (replay !== null) {
            assertContentPublicationIdempotency(
              serializeContentPublicationCommandIdentity(replay),
              {
                workspaceId: input.workspaceId,
                revision: recordedApproval.revision,
                approvalId: input.approvalId,
                fingerprint: recordedApproval.fingerprint.value,
                requestedBy: input.requestedBy,
              },
            );
            return replay;
          }
        }
        const { approval, revision } = await requireApproval(
          input.approvalId,
          input.requestedBy,
        );
        if (approval.workspaceId !== input.workspaceId) {
          throw new ContentApprovalInvalidError("approval_not_found");
        }
        const recoverableCandidate = await store.findLatestPublication(
          approval.workspaceId,
        );
        const terminalAttemptCanBeRestarted =
          recoverableCandidate?.commitSha === null &&
          ((recoverableCandidate.status === "failed" &&
            recoverableCandidate.detail === "git_operation_failed") ||
            (recoverableCandidate.status === "blocked" &&
              (recoverableCandidate.detail === "publication_in_progress" ||
                recoverableCandidate.detail ===
                  "publication_lease_lost")));
        if (
          recoverableCandidate !== null &&
          recoverableCandidate.approvalId === approval.id &&
          recoverableCandidate.fingerprint === approval.fingerprint.value &&
          !terminalAttemptCanBeRestarted
        ) {
          return activeStatuses.has(recoverableCandidate.status)
            ? (await refreshPublication(recoverableCandidate.id)) ??
                recoverableCandidate
            : recoverableCandidate;
        }
        const activePublication = await store.findActivePublication();
        if (activePublication !== null) {
          await refreshPublication(activePublication.id);
        }
        const base = parseProductionBase(approval.fingerprint.productionBase);
        const [headResult, baseIsLiveResult] = await Promise.allSettled([
          publisher.getProductionHead(),
          approvedBaseIsLive(approval),
        ]);
        if (
          headResult.status === "fulfilled" &&
          headResult.value !== base.commitSha
        ) {
          await invalidateForProductionChange(approval);
          throw new ContentApprovalInvalidError("production_head_moved");
        }
        if (
          baseIsLiveResult.status === "fulfilled" &&
          !baseIsLiveResult.value
        ) {
          await invalidateForProductionChange(approval);
          throw new ContentApprovalInvalidError("release_marker_mismatch");
        }
        if (headResult.status === "rejected") {
          throw headResult.reason;
        }
        if (baseIsLiveResult.status === "rejected") {
          throw baseIsLiveResult.reason;
        }
        if (approval.fingerprint.contentHash === base.contentHash) {
          throw new ContentPublicationValidationError(
            "publication_no_changes",
          );
        }
        const head = headResult.value;
        const contributors = await revisions.listContributors(
          approval.workspaceId,
          approval.revision,
        );
        const requestedAt = now();
        const publication: ContentPublication = Object.freeze({
          id: createContentPublicationId(randomHexId("publish")),
          workspaceId: approval.workspaceId,
          revision: approval.revision,
          approvalId: approval.id,
          fingerprint: approval.fingerprint.value,
          idempotencyKey: input.idempotencyKey,
          requestedBy: input.requestedBy,
          contributors,
          expectedHead: head,
          status: "requested",
          commitSha: null,
          deploymentId: null,
          deploymentRequestedAt: null,
          detail: null,
          leaseToken: crypto.randomUUID(),
          leaseExpiresAt: new Date(
            new Date(requestedAt).getTime() + publicationLeaseDurationMs,
          ).toISOString(),
          requestedAt,
          updatedAt: requestedAt,
        });
        const claim = await store.claimPublication(publication);
        if (claim.state !== "claimed") {
          return claim.publication;
        }
        const leaseToken = publication.leaseToken;
        const blockForLostLease = () =>
          store.updatePublication(
            nextPublication(publication, {
              status: "blocked",
              detail: "publication_lease_lost",
              leaseToken: null,
              leaseExpiresAt: null,
              updatedAt: now(),
            }),
            { expectedLeaseToken: leaseToken ?? undefined },
          );
        if (leaseToken === null) {
          return blockForLostLease();
        }
        const renewLease = createPublicationCommitLeaseGuard({
          publication,
          leaseToken,
          requestedBy: input.requestedBy,
        });
        if (!(await renewLease())) {
          return blockForLostLease();
        }
        try {
          await requireApproval(input.approvalId, input.requestedBy);
        } catch (error) {
          if (error instanceof ContentApprovalInvalidError) {
            return store.updatePublication(
              nextPublication(publication, {
                status: "blocked",
                detail: "approval_stale",
                leaseToken: null,
                leaseExpiresAt: null,
                updatedAt: now(),
              }),
              { expectedLeaseToken: leaseToken },
            );
          }
          throw error;
        }
        const result = await attemptAtomicPublicationCommit({
          publication,
          approval,
          revision,
          assertLease: renewLease,
        });
        const updatedAt = now();
        if (result.state === "committed") {
          return store.updatePublication(
            nextPublication(publication, {
              status: "committed",
              commitSha: result.commitSha,
              detail: null,
              leaseToken: null,
              leaseExpiresAt: null,
              updatedAt,
            }),
            {
              expectedLeaseToken: leaseToken,
              expectedLeaseValidAt: updatedAt,
            },
          );
        }
        if (
          result.state === "blocked" &&
          result.detail === "production_head_moved"
        ) {
          await invalidateForProductionChange(approval);
        }
        return store.updatePublication(
          nextPublication(publication, {
            status: result.state,
            detail: result.detail,
            leaseToken: null,
            leaseExpiresAt: null,
            updatedAt,
          }),
          reconciliationCandidate(result.detail) === undefined
            ? {
                expectedLeaseToken: leaseToken,
                expectedLeaseValidAt: updatedAt,
              }
            : { expectedLeaseToken: leaseToken },
        );
      },
      async refresh(publicationId: ContentPublicationId) {
        return refreshPublication(publicationId);
      },
      async retryDeployment(
        publicationId: ContentPublicationId,
        requestedBy: HumanMembershipId,
      ) {
        let publication = await store.findPublication(publicationId);
        if (
          publication !== null &&
          activeStatuses.has(publication.status) &&
          (publication.detail?.startsWith("deployment_retry_") ||
            reconciliationCandidate(publication.detail) !== undefined)
        ) {
          return publication;
        }
        const candidateCommitSha =
          publication === null
            ? undefined
            : reconciliationCandidate(publication.detail);
        if (
          publication === null ||
          publication.status !== "failed" ||
          (publication.commitSha === null &&
            candidateCommitSha === undefined &&
            !contentPublicationHasUnresolvedGitOutcome(publication))
        ) {
          throw new ContentPublicationValidationError(
            "deployment_retry_not_available",
          );
        }
        const { approval, revision } = await requireApproval(
          publication.approvalId,
          requestedBy,
        );
        if (
          approval.fingerprint.value !== publication.fingerprint
        ) {
          throw new ContentApprovalInvalidError("approval_stale");
        }
        if (
          publication.commitSha === null &&
          candidateCommitSha === undefined &&
          contentPublicationHasUnresolvedGitOutcome(publication)
        ) {
          const reconciled = await publisher.reconcileCommit(
            commitReconciliationInput(publication, approval, revision),
          );
          if (reconciled.state === "committed") {
            publication = await store.updatePublication(
              nextPublication(publication, {
                status: "failed",
                commitSha: reconciled.commitSha,
                detail: "git_commit_reconciled",
                updatedAt: now(),
              }),
              {
                expectedStatus: "failed",
                expectedUpdatedAt: publication.updatedAt,
              },
            );
          } else {
            const [currentHead, baseIsLive] = await Promise.all([
              publisher.getProductionHead(),
              approvedBaseIsLive(approval),
            ]);
            if (currentHead !== publication.expectedHead) {
              const retryReconciliation = await publisher.reconcileCommit(
                commitReconciliationInput(publication, approval, revision),
              );
              if (retryReconciliation.state !== "committed") {
                return publication;
              }
              publication = await store.updatePublication(
                nextPublication(publication, {
                  status: "failed",
                  commitSha: retryReconciliation.commitSha,
                  detail: "git_commit_reconciled",
                  updatedAt: now(),
                }),
                {
                  expectedStatus: "failed",
                  expectedUpdatedAt: publication.updatedAt,
                },
              );
            } else {
              if (!baseIsLive) {
                await invalidateForProductionChange(approval);
                throw new ContentPublicationValidationError(
                  "deployment_retry_release_marker_mismatch",
                );
              }
              const { dispatching, leaseToken } =
                await claimFailedPublicationRetry(
                  publication,
                  "git_result_unknown",
                );
              if (
                dispatching.status !== "requested" ||
                dispatching.leaseToken !== leaseToken
              ) {
                return dispatching;
              }
              const retryPublication = publication;
              const assertLease = createPublicationCommitLeaseGuard({
                publication: retryPublication,
                leaseToken,
                requestedBy,
              });
              let result = await attemptAtomicPublicationCommit({
                publication: retryPublication,
                approval,
                revision,
                assertLease,
              });
              if (
                result.state === "blocked" &&
                result.detail === "production_head_moved"
              ) {
                const afterCas = await publisher.reconcileCommit(
                  commitReconciliationInput(
                    retryPublication,
                    approval,
                    revision,
                  ),
                );
                if (afterCas.state === "committed") {
                  result = afterCas;
                } else if (afterCas.state === "unknown") {
                  result = {
                    state: "unknown",
                    detail: "git_result_unknown",
                  };
                } else {
                  await invalidateForProductionChange(approval);
                }
              }
              const updatedAt = now();
              return store.updatePublication(
                nextPublication(dispatching, {
                  status:
                    result.state === "blocked" &&
                    result.detail === "publication_lease_lost"
                      ? "failed"
                      : result.state,
                  commitSha:
                    result.state === "committed"
                      ? result.commitSha
                      : null,
                  detail:
                    result.state === "committed"
                      ? null
                      : result.state === "unknown"
                        ? "git_result_unknown"
                        : result.detail,
                  leaseToken: null,
                  leaseExpiresAt: null,
                  updatedAt,
                }),
                {
                  expectedLeaseToken: leaseToken,
                  expectedLeaseValidAt: updatedAt,
                },
              );
            }
          }
        }
        if (
          publication.commitSha === null &&
          candidateCommitSha !== undefined
        ) {
          const reconciled = await publisher.reconcileCommit({
            ...commitReconciliationInput(
              publication,
              approval,
              revision,
            ),
            candidateCommitSha,
          });
          if (reconciled.state === "committed") {
            const reconciledAt = now();
            publication = await store.updatePublication(
              nextPublication(publication, {
                status: "failed",
                commitSha: reconciled.commitSha,
                detail: "git_commit_reconciled",
                leaseToken: null,
                leaseExpiresAt: null,
                updatedAt: reconciledAt,
              }),
              {
                expectedStatus: "failed",
                expectedUpdatedAt: publication.updatedAt,
              },
            );
            if (publication.commitSha !== candidateCommitSha) {
              return publication;
            }
          }
        }
        if (
          publication.commitSha === null &&
          candidateCommitSha !== undefined
        ) {
          const [currentHead, baseIsLive] = await Promise.all([
            publisher.getProductionHead(),
            approvedBaseIsLive(approval),
          ]);
          if (
            currentHead !== publication.expectedHead ||
            !baseIsLive
          ) {
            await invalidateForProductionChange(approval);
            throw new ContentPublicationValidationError(
              currentHead !== publication.expectedHead
                ? "deployment_retry_head_moved"
                : "deployment_retry_release_marker_mismatch",
            );
          }
          const { dispatching, leaseToken } =
            await claimFailedPublicationRetry(
              publication,
              `git_reference_result_unknown:${candidateCommitSha}`,
            );
          if (
            dispatching.status !== "requested" ||
            dispatching.leaseToken !== leaseToken
          ) {
            return dispatching;
          }
          const assertLease = createPublicationCommitLeaseGuard({
            publication,
            leaseToken,
            requestedBy,
          });
          const result = await publisher.retryReference({
            publishId: publication.id,
            candidateCommitSha,
            expectedHead: publication.expectedHead,
            artifacts: serializeContentPublicationArtifacts(
              revision.definition,
            ),
            artifactHash: approval.fingerprint.artifactHash,
            assertLease,
          });
          const updatedAt = now();
          const retryStatus =
            result.state === "blocked" &&
            result.detail === "publication_lease_lost"
              ? "failed"
              : result.state;
          if (
            result.state === "blocked" &&
            result.detail === "production_head_moved"
          ) {
            await invalidateForProductionChange(approval);
          }
          return store.updatePublication(
            nextPublication(dispatching, {
              status: retryStatus,
              commitSha:
                result.state === "committed"
                  ? result.commitSha
                  : null,
              detail:
                result.state === "committed"
                  ? null
                  : result.state === "unknown"
                    ? `git_reference_result_unknown:${candidateCommitSha}`
                    : result.detail === "git_reference_candidate_invalid"
                      ? result.detail
                      : `git_reference_not_advanced:${candidateCommitSha}`,
              leaseToken: null,
              leaseExpiresAt: null,
              updatedAt,
            }),
            {
              expectedLeaseToken: leaseToken,
              expectedLeaseValidAt: updatedAt,
            },
          );
        }
        const commitSha = publication.commitSha;
        if (commitSha === null) {
          throw new ContentPublicationValidationError(
            "deployment_retry_not_available",
          );
        }
        try {
          if (
            await publisher.isReleaseLive({
              commitSha,
              contentHash: approval.fingerprint.contentHash,
              schemaVersion: approval.fingerprint.schemaVersion,
            })
          ) {
            return store.updatePublication(
              nextPublication(publication, {
                status: "verified-live",
                detail: null,
                updatedAt: now(),
              }),
              {
                expectedStatus: "failed",
                expectedUpdatedAt: publication.updatedAt,
              },
            );
          }
        } catch {
          // A missing marker still permits one explicitly requested retry.
        }
        const reconciledCommitNeedsDeploymentCheck =
          publication.detail === "git_commit_reconciled" &&
          publication.deploymentRequestedAt === null;
        if (
          reconciledCommitNeedsDeploymentCheck ||
          deploymentRetryDispatchWasAttempted(publication)
        ) {
          const recordedDeploymentId =
            publication.deploymentId !== null &&
            !publication.deploymentId.startsWith("retry-dispatch:")
              ? publication.deploymentId
              : undefined;
          const observed = await publisher.getDeploymentStatus(
            commitSha,
            recordedDeploymentId,
          );
          if (
            observed === "building" ||
            observed === "deployed"
          ) {
            return store.updatePublication(
              nextPublication(publication, {
                status: observed,
                detail: "deployment_retry_reconciled",
                updatedAt: now(),
              }),
              {
                expectedStatus: "failed",
                expectedUpdatedAt: publication.updatedAt,
              },
            );
          }
          if (
            observed !== "failed" ||
            (recordedDeploymentId === undefined &&
              !reconciledCommitNeedsDeploymentCheck)
          ) {
            return publication;
          }
        }
        if ((await publisher.getProductionHead()) !== commitSha) {
          await store.invalidateApproval({
            approvalId: approval.id,
            invalidatedAt: now(),
            reason: "production_changed",
          });
          throw new ContentPublicationValidationError(
            "deployment_retry_head_moved",
          );
        }
        const activePublication = await store.findActivePublication();
        if (activePublication !== null) {
          throw new ContentPublicationValidationError(
            "deployment_retry_in_progress",
          );
        }
        const retryRequestedAt = now();
        const dispatchToken = `retry-dispatch:${crypto.randomUUID()}`;
        const leaseToken = crypto.randomUUID();
        let dispatching: ContentPublication;
        try {
          dispatching = await store.updatePublication(
            nextPublication(publication, {
              status: "committed",
              detail: "deployment_retry_dispatching",
              deploymentId: dispatchToken,
              deploymentRequestedAt: retryRequestedAt,
              leaseToken,
              leaseExpiresAt: new Date(
                new Date(retryRequestedAt).getTime() +
                  publicationLeaseDurationMs,
              ).toISOString(),
              updatedAt: retryRequestedAt,
            }),
            {
              expectedStatus: "failed",
              expectedUpdatedAt: publication.updatedAt,
            },
          );
        } catch (error) {
          if ((await store.findActivePublication()) !== null) {
            throw new ContentPublicationValidationError(
              "deployment_retry_in_progress",
            );
          }
          throw error;
        }
        if (
          dispatching.status !== "committed" ||
          dispatching.detail !== "deployment_retry_dispatching" ||
          dispatching.deploymentId !== dispatchToken ||
          dispatching.leaseToken !== leaseToken
        ) {
          return dispatching;
        }
        try {
          await requireApproval(publication.approvalId, requestedBy);
        } catch {
          return store.updatePublication(
            nextPublication(dispatching, {
              status: "failed",
              detail: "approval_stale",
              deploymentId: null,
              leaseToken: null,
              leaseExpiresAt: null,
              updatedAt: now(),
            }),
            {
              expectedLeaseToken: leaseToken,
              expectedStatus: "committed",
              expectedUpdatedAt: dispatching.updatedAt,
            },
          );
        }
        let productionHead: string;
        try {
          productionHead = await publisher.getProductionHead();
        } catch {
          return store.updatePublication(
            nextPublication(dispatching, {
              status: "failed",
              detail: "deployment_retry_head_unavailable",
              deploymentId: null,
              leaseToken: null,
              leaseExpiresAt: null,
              updatedAt: now(),
            }),
            {
              expectedLeaseToken: leaseToken,
              expectedStatus: "committed",
              expectedUpdatedAt: dispatching.updatedAt,
            },
          );
        }
        if (productionHead !== commitSha) {
          const invalidatedAt = now();
          await store.invalidateApproval({
            approvalId: approval.id,
            invalidatedAt,
            reason: "production_changed",
          });
          return store.updatePublication(
            nextPublication(dispatching, {
              status: "failed",
              detail: "deployment_retry_head_moved",
              deploymentId: null,
              leaseToken: null,
              leaseExpiresAt: null,
              updatedAt: invalidatedAt,
            }),
            {
              expectedLeaseToken: leaseToken,
              expectedStatus: "committed",
              expectedUpdatedAt: dispatching.updatedAt,
            },
          );
        }
        const renewDeploymentRetryClaim = async () => {
          const leaseNow = now();
          return store.renewPublicationLease({
            publicationId: publication.id,
            leaseToken,
            now: leaseNow,
            leaseExpiresAt: new Date(
              new Date(leaseNow).getTime() + publicationLeaseDurationMs,
            ).toISOString(),
            expectedStatus: "committed",
            expectedDetail: "deployment_retry_dispatching",
            expectedDeploymentId: dispatchToken,
          });
        };
        const assertDispatch = async () => {
          if (!(await renewDeploymentRetryClaim())) {
            return false;
          }
          try {
            await requireApproval(publication.approvalId, requestedBy);
          } catch {
            return false;
          }
          let releaseIsLive = false;
          try {
            releaseIsLive = await publisher.isReleaseLive({
              commitSha,
              contentHash: approval.fingerprint.contentHash,
              schemaVersion: approval.fingerprint.schemaVersion,
            });
          } catch {
            // A missing marker does not consume the explicit retry authority.
          }
          if (releaseIsLive) {
            try {
              const verifiedAt = now();
              await store.updatePublication(
                nextPublication(dispatching, {
                  status: "verified-live",
                  detail: null,
                  deploymentId: null,
                  leaseToken: null,
                  leaseExpiresAt: null,
                  updatedAt: verifiedAt,
                }),
                {
                  expectedLeaseToken: leaseToken,
                  expectedLeaseValidAt: verifiedAt,
                  expectedStatus: "committed",
                  expectedUpdatedAt: dispatching.updatedAt,
                },
              );
            } catch {
              // The exact live observation still vetoes a duplicate dispatch.
            }
            return false;
          }
          let boundaryHead: string;
          try {
            boundaryHead = await publisher.getProductionHead();
          } catch {
            return false;
          }
          if (boundaryHead !== commitSha) {
            const invalidatedAt = now();
            await store.invalidateApproval({
              approvalId: approval.id,
              invalidatedAt,
              reason: "production_changed",
            });
            await store.updatePublication(
              nextPublication(dispatching, {
                status: "failed",
                detail: "deployment_retry_head_moved",
                deploymentId: null,
                leaseToken: null,
                leaseExpiresAt: null,
                updatedAt: invalidatedAt,
              }),
              {
                expectedLeaseToken: leaseToken,
                expectedLeaseValidAt: invalidatedAt,
                expectedStatus: "committed",
                expectedUpdatedAt: dispatching.updatedAt,
              },
            );
            return false;
          }
          return renewDeploymentRetryClaim();
        };
        let result: Awaited<
          ReturnType<ContentPublisher["retryDeployment"]>
        >;
        try {
          result = await publisher.retryDeployment({
            commitSha,
            assertDispatch,
          });
        } catch {
          result = { state: "unknown" };
        }
        const status =
          result.state === "failed" || result.state === "blocked"
            ? "failed"
            : result.state === "unknown"
              ? "unknown"
              : "committed";
        return store.updatePublication(
          nextPublication(dispatching, {
            status,
            detail:
              result.state === "failed" || result.state === "blocked"
                ? result.state === "blocked"
                  ? result.detail
                  : "deployment_retry_failed"
                : result.state === "unknown"
                  ? "deployment_retry_result_unknown"
                  : "deployment_retry_requested",
            deploymentId:
              result.state === "requested" ? result.deploymentId : null,
            leaseToken: null,
            leaseExpiresAt: null,
            updatedAt: now(),
          }),
          {
            expectedLeaseToken: leaseToken,
            expectedStatus: "committed",
            expectedUpdatedAt: dispatching.updatedAt,
          },
        );
      },
      async restore(input: {
        sourcePublicationId: ContentPublicationId;
        workspaceId: ContentWorkspaceId;
        actorId: ContentActorId;
        idempotencyKey: string;
      }) {
        if (!isValidContentMutationIdempotencyKey(input.idempotencyKey)) {
          throw new ContentPublicationValidationError(
            "idempotency_key_invalid",
          );
        }
        if (
          publishedRevisions === undefined ||
          draftRestorer === undefined
        ) {
          throw new ContentPublicationValidationError(
            "restore_not_configured",
          );
        }
        const publication =
          restoreSourcePublication?.id === input.sourcePublicationId
            ? restoreSourcePublication
            : await store.findPublication(input.sourcePublicationId);
        if (publication === null) {
          throw new ContentPublicationValidationError(
            "restore_source_not_found",
          );
        }
        if (
          publication.status !== "verified-live" ||
          publication.commitSha === null
        ) {
          throw new ContentPublicationValidationError(
            "restore_source_not_live",
          );
        }
        await store.claimRestoreIdentity(input);
        const approval = await store.findApproval(publication.approvalId);
        if (approval === null) {
          throw new ContentPublicationValidationError(
            "restore_artifact_unavailable",
          );
        }
        const bytes = await publishedRevisions.readPublishedArtifact({
          commitSha: publication.commitSha,
          path: publishedSiteDefinitionPath,
        });
        if (bytes === null) {
          throw new ContentPublicationValidationError(
            "restore_artifact_unavailable",
          );
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(bytes);
        } catch {
          throw new ContentPublicationValidationError(
            "restore_artifact_mismatch",
          );
        }
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed) ||
          !("schemaVersion" in parsed)
        ) {
          throw new ContentPublicationValidationError(
            "restore_artifact_mismatch",
          );
        }
        const definition = parsed as SiteDefinition;
        const artifacts = serializeContentPublicationArtifacts(definition);
        const [artifactHash, contentHash, publishedArtifactBytes] =
          await Promise.all([
            hashContentPublicationArtifacts(artifacts),
            hashPublishedSiteDefinition(definition),
            Promise.all(
              artifacts.map((artifact) =>
                artifact.path === publishedSiteDefinitionPath
                  ? bytes
                  : publishedRevisions.readPublishedArtifact({
                      commitSha: publication.commitSha!,
                      path: artifact.path,
                    }),
              ),
            ),
          ]);
        if (
          artifactHash !== approval.fingerprint.artifactHash ||
          contentHash !== approval.fingerprint.contentHash ||
          serializePublishedSiteDefinition(definition) !== bytes ||
          definition.schemaVersion !== approval.fingerprint.schemaVersion ||
          publishedArtifactBytes.some(
            (publishedBytes, index) =>
              publishedBytes !== artifacts[index]!.bytes,
          )
        ) {
          throw new ContentPublicationValidationError(
            "restore_artifact_mismatch",
          );
        }
        return draftRestorer.restore({
          ...input,
          definition,
        });
      },
    }),
    queries: Object.freeze({
      getLatest(workspaceId: ContentWorkspaceId) {
        return store.findLatestPublication(workspaceId);
      },
      get(publicationId: ContentPublicationId) {
        return store.findPublication(publicationId);
      },
      listHistory() {
        return store.listPublicationHistory(50);
      },
    }),
  });
}
