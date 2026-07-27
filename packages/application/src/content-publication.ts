import type { SiteDefinition } from "@foundry/site-definition";

import type {
  ContentActorId,
  ContentRevision,
  ContentWorkspaceId,
} from "./content-revisions";
import type { HumanMembershipId } from "./human-access";

export const publishedSiteDefinitionPath =
  "packages/site-definition/src/published-site.json";
export const contentSerializationVersion =
  "foundry.site-definition.canonical-json.v1";

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
  contentHash: string;
  designHash: string;
  schemaVersion: SiteDefinition["schemaVersion"];
  rendererVersion: string;
  productionBase: string;
  artifactHash: string;
  serializationVersion: typeof contentSerializationVersion;
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
  detail: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  requestedAt: string;
  updatedAt: string;
}>;

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
  | Readonly<{ state: "unknown"; detail: string }>;

export type ContentPublisher = Readonly<{
  getProductionHead(): Promise<string>;
  isReleaseLive(expected: {
    commitSha: string;
    contentHash: string;
    schemaVersion: SiteDefinition["schemaVersion"];
  }): Promise<boolean>;
  createCommit(input: {
    publishId: ContentPublicationId;
    workspaceId: ContentWorkspaceId;
    revision: number;
    approvedBy: HumanMembershipId;
    contributors: ReadonlyArray<ContentActorId>;
    contentHash: string;
    expectedHead: string;
    path: typeof publishedSiteDefinitionPath;
    bytes: string;
    message: string;
    assertLease(): Promise<boolean>;
  }): Promise<PublicationCommitResult>;
  reconcileCommit(
    publishId: ContentPublicationId,
  ): Promise<
    | Readonly<{ state: "committed"; commitSha: string }>
    | Readonly<{ state: "not-found" | "unknown" }>
  >;
  getDeploymentStatus(
    commitSha: string,
  ): Promise<"requested" | "building" | "deployed" | "failed" | "unknown">;
}>;

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

export class ContentPublicationValidationError extends Error {
  readonly code:
    | "preview_confirmation_required"
    | "idempotency_key_invalid"
    | "production_base_invalid";

  constructor(code: ContentPublicationValidationError["code"]) {
    super(code);
    this.name = "ContentPublicationValidationError";
    this.code = code;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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

export function hashPublishedSiteDefinition(
  definition: SiteDefinition,
): Promise<string> {
  return sha256(canonicalJson(definition));
}

function designProjection(definition: SiteDefinition) {
  return {
    definitionVersion: definition.definitionVersion,
    siteId: definition.site.id,
    navigation: definition.site.navigation.map(({ id, href }) => ({
      id,
      href,
    })),
    pageId: definition.home.id,
    sections: definition.home.sections.map(({ id, type }) => ({ id, type })),
  };
}

export async function createContentApprovalFingerprint(
  revision: ContentRevision,
  channel: ContentPublicationChannel = "site",
): Promise<ContentApprovalFingerprint> {
  const serialized = serializePublishedSiteDefinition(revision.definition);
  const artifactHash = await sha256(serialized);
  const canonicalDefinitionHash = await sha256(
    canonicalJson(revision.definition),
  );
  if (canonicalDefinitionHash !== revision.inputs.contentHash) {
    throw new ContentApprovalInvalidError("revision_stale");
  }
  const designHash = await sha256(canonicalJson(designProjection(
    revision.definition,
  )));
  const binding = {
    channel,
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

export function createInMemoryContentPublicationStore(): ContentPublicationStore {
  const approvals = new Map<ContentApprovalId, ContentApproval>();
  const publications = new Map<ContentPublicationId, ContentPublication>();

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
        return { state: "blocked", publication: blocked };
      }
      publications.set(publication.id, publication);
      return { state: "claimed", publication };
    },
    async hasPublicationLease({ publicationId, leaseToken, now }) {
      const publication = publications.get(publicationId);
      return (
        publication?.status === "requested" &&
        publication.leaseToken === leaseToken &&
        publication.leaseExpiresAt !== null &&
        publication.leaseExpiresAt > now
      );
    },
    async renewPublicationLease({
      publicationId,
      leaseToken,
      now,
      leaseExpiresAt,
    }) {
      const publication = publications.get(publicationId);
      if (
        publication?.status !== "requested" ||
        publication.leaseToken !== leaseToken ||
        publication.leaseExpiresAt === null ||
        publication.leaseExpiresAt <= now
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
        (current?.status !== "requested" ||
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
  };
}

export function createContentPublicationApplication({
  store,
  revisions,
  publisher,
  now = () => new Date().toISOString(),
}: {
  store: ContentPublicationStore;
  revisions: ContentPublicationRevisionRepository;
  publisher: ContentPublisher;
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
    const fingerprint = await createContentApprovalFingerprint(revision);
    if (fingerprint.value !== approval.fingerprint.value) {
      throw new ContentApprovalInvalidError("approval_stale");
    }
    if (actorId.trim() === "") {
      throw new ContentApprovalInvalidError("approval_not_found");
    }
    return { approval, revision };
  }

  async function refreshPublication(publicationId: ContentPublicationId) {
    const publication = await store.findPublication(publicationId);
    if (publication === null) {
      return null;
    }
    if (publication.status === "verified-live") {
      return publication;
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
      const reconciled = await publisher.reconcileCommit(publication.id);
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
        );
      } else if (reconciled.state === "not-found") {
        return store.updatePublication(
          nextPublication(publication, {
            status: "failed",
            detail:
              publication.status === "requested"
                ? "publication_lease_expired"
                : "git_commit_not_found",
            leaseToken: null,
            leaseExpiresAt: null,
            updatedAt: now(),
          }),
          {
            expectedStatus: publication.status,
            expectedUpdatedAt: publication.updatedAt,
          },
        );
      } else {
        const observedAt = now();
        if (
          new Date(observedAt).getTime() -
            new Date(publication.requestedAt).getTime() >=
          deploymentSignalTimeoutMs
        ) {
          return store.updatePublication(
            nextPublication(publication, {
              status: "failed",
              detail: "git_reconciliation_timeout",
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
    const deployment = await publisher.getDeploymentStatus(commitSha);
    const observedAt = now();
    const timedOut =
      new Date(observedAt).getTime() -
        new Date(currentPublication.requestedAt).getTime() >=
      deploymentSignalTimeoutMs;
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

    if (deployment === "failed") {
      return update("failed", "cloudflare_build_failed");
    }
    if (
      deployment === "deployed" ||
      currentPublication.status === "deployed"
    ) {
      const approval = await store.findApproval(currentPublication.approvalId);
      if (approval === null) {
        return update(
          timedOut ? "failed" : "unknown",
          "approval_record_missing",
        );
      }
      const live = await publisher.isReleaseLive({
        commitSha,
        contentHash: approval.fingerprint.contentHash,
        schemaVersion: approval.fingerprint.schemaVersion,
      });
      if (live) {
        return update("verified-live", null);
      }
      return update(
        timedOut ? "failed" : "deployed",
        timedOut ? "release_marker_timeout" : "release_marker_pending",
      );
    }
    if (timedOut && activeStatuses.has(currentPublication.status)) {
      return update("failed", "deployment_signal_timeout");
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
    return update(deployment, null);
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
          fingerprint: await createContentApprovalFingerprint(revision),
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
        if (!/^[A-Za-z0-9._:-]{16,128}$/u.test(input.idempotencyKey)) {
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
        const activePublication = await store.findActivePublication();
        if (activePublication !== null) {
          await refreshPublication(activePublication.id);
        }
        const base = parseProductionBase(
          approval.fingerprint.productionBase,
        );
        const [head, baseIsLive] = await Promise.all([
          publisher.getProductionHead(),
          publisher.isReleaseLive({
            commitSha: base.commitSha,
            contentHash: base.contentHash,
            schemaVersion: approval.fingerprint.schemaVersion,
          }),
        ]);
        if (head !== base.commitSha) {
          await store.invalidateApproval({
            approvalId: approval.id,
            invalidatedAt: now(),
            reason: "production_changed",
          });
          throw new ContentApprovalInvalidError("production_head_moved");
        }
        if (!baseIsLive) {
          await store.invalidateApproval({
            approvalId: approval.id,
            invalidatedAt: now(),
            reason: "production_changed",
          });
          throw new ContentApprovalInvalidError("release_marker_mismatch");
        }
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
          detail: null,
          leaseToken: crypto.randomUUID(),
          leaseExpiresAt: new Date(
            new Date(requestedAt).getTime() + 2 * 60 * 1_000,
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
        const renewLease = () => {
          const leaseNow = now();
          return store.renewPublicationLease({
            publicationId: publication.id,
            leaseToken,
            now: leaseNow,
            leaseExpiresAt: new Date(
              new Date(leaseNow).getTime() + 2 * 60 * 1_000,
            ).toISOString(),
          });
        };
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
        let result: PublicationCommitResult;
        try {
          result = await publisher.createCommit({
            publishId: publication.id,
            workspaceId: publication.workspaceId,
            revision: publication.revision,
            approvedBy: approval.approvedBy,
            contributors,
            contentHash: approval.fingerprint.contentHash,
            expectedHead: head,
            path: publishedSiteDefinitionPath,
            bytes: serializePublishedSiteDefinition(revision.definition),
            message: commitMessage({ publication, approval }),
            assertLease: renewLease,
          });
        } catch {
          result = {
            state: "unknown",
            detail: "git_result_ambiguous",
          };
        }
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
          await store.invalidateApproval({
            approvalId: approval.id,
            invalidatedAt: updatedAt,
            reason: "production_changed",
          });
        }
        return store.updatePublication(
          nextPublication(publication, {
            status: result.state,
            detail: result.detail,
            leaseToken: null,
            leaseExpiresAt: null,
            updatedAt,
          }),
          {
            expectedLeaseToken: leaseToken,
            expectedLeaseValidAt: updatedAt,
          },
        );
      },
      async refresh(publicationId: ContentPublicationId) {
        return refreshPublication(publicationId);
      },
    }),
    queries: Object.freeze({
      getLatest(workspaceId: ContentWorkspaceId) {
        return store.findLatestPublication(workspaceId);
      },
      get(publicationId: ContentPublicationId) {
        return store.findPublication(publicationId);
      },
    }),
  });
}
