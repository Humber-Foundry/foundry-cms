import {
  serializeRichTextDocument,
  validateRichTextDocument,
  type RichTextDocument,
  type SiteId,
} from "@foundry/site-definition";
import { canonicalJson, sha256CanonicalJson } from "./deterministic-hash";

export const blogPostSchemaVersion = "foundry.blog-post.v1" as const;

declare const blogPostIdBrand: unique symbol;
export type BlogPostId = string & {
  readonly [blogPostIdBrand]: "BlogPostId";
};

declare const blogPostRevisionIdBrand: unique symbol;
export type BlogPostRevisionId = string & {
  readonly [blogPostRevisionIdBrand]: "BlogPostRevisionId";
};

declare const blogPostActorIdBrand: unique symbol;
export type BlogPostActorId = string & {
  readonly [blogPostActorIdBrand]: "BlogPostActorId";
};

declare const postApprovalIdBrand: unique symbol;
export type PostApprovalId = string & {
  readonly [postApprovalIdBrand]: "PostApprovalId";
};

declare const postPublicationIdBrand: unique symbol;
export type PostPublicationId = string & {
  readonly [postPublicationIdBrand]: "PostPublicationId";
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function uuid<Value extends string>(value: string, code: string): Value {
  if (!uuidPattern.test(value)) {
    throw new TypeError(code);
  }
  return value as Value;
}

export function createBlogPostId(value: string): BlogPostId {
  return uuid<BlogPostId>(value, "blog_post_id_invalid");
}

export function createPostPublicationId(value: string): PostPublicationId {
  return uuid<PostPublicationId>(value, "post_publication_id_invalid");
}

export function createBlogPostActorId(value: string): BlogPostActorId {
  if (
    !/^(?:membership|mcp)_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value,
    )
  ) {
    throw new TypeError("blog_post_actor_id_invalid");
  }
  return value as BlogPostActorId;
}

export type BlogPostActor = Readonly<{
  id: BlogPostActorId;
  role: "owner" | "editor" | "agent";
  human: boolean;
}>;

export type BlogPostMetadata = Readonly<{
  title: string;
  slug: string;
  excerpt: string;
  seoTitle: string;
  seoDescription: string;
}>;

export type BlogPostRevision = Readonly<{
  id: BlogPostRevisionId;
  siteId: SiteId;
  postId: BlogPostId;
  number: number;
  schemaVersion: typeof blogPostSchemaVersion;
  metadata: BlogPostMetadata;
  body: RichTextDocument;
  contentHash: string;
  createdAt: string;
  createdBy: BlogPostActorId;
}>;

export type BlogPost = Readonly<{
  id: BlogPostId;
  siteId: SiteId;
  version: number;
  currentRevisionNumber: number;
  liveRevisionNumber: number | null;
  workflow:
    | "editing"
    | "approval_required"
    | "approved"
    | "executing"
    | "failed";
  activePublicationId: PostPublicationId | null;
}>;

export type PostArtifactFingerprint = string & {
  readonly __postArtifactFingerprint: true;
};

export type BlogPostPreview = Readonly<{
  revisionId: BlogPostRevisionId;
  revisionNumber: number;
  fingerprint: PostArtifactFingerprint;
  rendererVersion: string;
  schemaVersion: typeof blogPostSchemaVersion;
  artifact: string;
  createdAt: string;
  createdBy: BlogPostActorId;
}>;

export type BlogPostApproval = Readonly<{
  id: PostApprovalId;
  revisionId: BlogPostRevisionId;
  revisionNumber: number;
  fingerprint: PostArtifactFingerprint;
  approvedAt: string;
  approvedBy: BlogPostActorId;
  invalidatedAt: string | null;
}>;

export type PostPublicationReceipt = Readonly<{
  publicationId: PostPublicationId;
  fingerprint: PostArtifactFingerprint;
  deploymentId: string;
}>;

export type PostPublicationRequest = Readonly<{
  publicationId: PostPublicationId;
  siteId: SiteId;
  postId: BlogPostId;
  kind: "publish" | "unpublish";
  revisionId: BlogPostRevisionId;
  revisionNumber: number;
  fingerprint: PostArtifactFingerprint;
  artifact: string | null;
  rendererVersion: string;
  schemaVersion: typeof blogPostSchemaVersion;
  productionBase: string;
  channelConfigurationHash: string;
  attributedActorId: BlogPostActorId;
}>;

export type BlogPostPublication = Readonly<{
  id: PostPublicationId;
  siteId: SiteId;
  postId: BlogPostId;
  kind: "publish" | "unpublish";
  revisionId: BlogPostRevisionId;
  revisionNumber: number;
  fingerprint: PostArtifactFingerprint;
  attributedActorId: BlogPostActorId;
  requestedAt: string;
  status: "requested" | "deployed" | "verified-live" | "failed";
  receipt: PostPublicationReceipt | null;
}>;

export type BlogPostPublicationPipeline = Readonly<{
  rendererVersion: string;
  schemaVersion: typeof blogPostSchemaVersion;
  productionBase: string;
  channelConfigurationHash: string;
  publish(request: PostPublicationRequest): Promise<PostPublicationReceipt>;
  verifyLive(receipt: PostPublicationReceipt): Promise<
    Readonly<{
      publicationId: PostPublicationId;
      fingerprint: PostArtifactFingerprint;
      live: boolean;
    }>
  >;
}>;

type BlogPostRecord = Readonly<{
  post: BlogPost;
  revisions: ReadonlyArray<BlogPostRevision>;
  previews: ReadonlyArray<BlogPostPreview>;
  approvals: ReadonlyArray<BlogPostApproval>;
  publications: ReadonlyArray<BlogPostPublication>;
}>;

export type BlogPostStore = Readonly<{
  create(record: BlogPostRecord): Promise<BlogPostRecord>;
  find(siteId: SiteId, postId: BlogPostId): Promise<BlogPostRecord | null>;
  update(
    siteId: SiteId,
    postId: BlogPostId,
    expectedVersion: number,
    mutate: (record: BlogPostRecord) => BlogPostRecord,
  ): Promise<BlogPostRecord>;
  updateExecution(
    siteId: SiteId,
    postId: BlogPostId,
    publicationId: PostPublicationId,
    mutate: (record: BlogPostRecord) => BlogPostRecord,
  ): Promise<BlogPostRecord>;
}>;

export class BlogPostError extends Error {
  constructor(
    readonly code:
      | "schema_invalid"
      | "post_not_found"
      | "post_already_exists"
      | "cross_site_identifier"
      | "revision_conflict"
      | "revision_not_current"
      | "preview_required"
      | "preview_stale"
      | "human_approval_required"
      | "approval_stale"
      | "publication_in_progress"
      | "publication_not_found"
      | "publication_evidence_mismatch"
      | "post_not_live"
      | "transition_forbidden"
      | "actor_forbidden",
    readonly fields: Readonly<Record<string, string>> = {},
  ) {
    super(code);
    this.name = "BlogPostError";
  }
}

function freeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    freeze(child);
  }
  return Object.freeze(value);
}

function snapshot(record: BlogPostRecord): BlogPostRecord {
  return freeze(structuredClone(record));
}

export function createInMemoryBlogPostStore(): BlogPostStore {
  const records = new Map<string, BlogPostRecord>();
  const key = (siteId: SiteId, postId: BlogPostId) => `${siteId}:${postId}`;

  function requireRecord(siteId: SiteId, postId: BlogPostId) {
    const record = records.get(key(siteId, postId));
    if (record === undefined) {
      throw new BlogPostError("post_not_found");
    }
    return record;
  }

  return Object.freeze({
    async create(record) {
      const recordKey = key(record.post.siteId, record.post.id);
      const existing = records.get(recordKey);
      if (existing !== undefined) {
        throw new BlogPostError("post_already_exists");
      }
      const stored = snapshot(record);
      records.set(recordKey, stored);
      return stored;
    },
    async find(requestedSiteId, requestedPostId) {
      return records.get(key(requestedSiteId, requestedPostId)) ?? null;
    },
    async update(requestedSiteId, requestedPostId, expectedVersion, mutate) {
      const current = requireRecord(requestedSiteId, requestedPostId);
      if (current.post.version !== expectedVersion) {
        throw new BlogPostError("revision_conflict", {
          currentVersion: String(current.post.version),
        });
      }
      const updated = snapshot(mutate(current));
      if (
        updated.post.id !== requestedPostId ||
        updated.post.siteId !== requestedSiteId ||
        updated.post.version !== expectedVersion + 1
      ) {
        throw new BlogPostError("transition_forbidden");
      }
      records.set(key(requestedSiteId, requestedPostId), updated);
      return updated;
    },
    async updateExecution(requestedSiteId, requestedPostId, publicationId, mutate) {
      const current = requireRecord(requestedSiteId, requestedPostId);
      if (current.post.activePublicationId !== publicationId) {
        throw new BlogPostError("publication_evidence_mismatch");
      }
      const updated = snapshot(mutate(current));
      if (updated.post.version !== current.post.version) {
        throw new BlogPostError("transition_forbidden");
      }
      records.set(key(requestedSiteId, requestedPostId), updated);
      return updated;
    },
  });
}

function assertCanAuthor(actor: BlogPostActor) {
  if (
    !["owner", "editor", "agent"].includes(actor.role) ||
    (actor.role === "agent" && actor.human)
  ) {
    throw new BlogPostError("actor_forbidden");
  }
}

function assertCanAuthorize(actor: BlogPostActor) {
  if (
    !actor.human ||
    (actor.role !== "owner" && actor.role !== "editor")
  ) {
    throw new BlogPostError("human_approval_required");
  }
}

function validateMetadata(metadata: BlogPostMetadata) {
  const fields: Record<string, string> = {};
  if (
    typeof metadata?.title !== "string" ||
    metadata.title.trim().length === 0 ||
    metadata.title.length > 160
  ) {
    fields.title = "Use a title between 1 and 160 characters.";
  }
  if (
    typeof metadata?.slug !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(metadata.slug)
  ) {
    fields.slug = "Use a lowercase URL slug.";
  }
  if (
    typeof metadata?.excerpt !== "string" ||
    metadata.excerpt.trim().length === 0 ||
    metadata.excerpt.length > 320
  ) {
    fields.excerpt = "Use an excerpt between 1 and 320 characters.";
  }
  if (
    typeof metadata?.seoTitle !== "string" ||
    metadata.seoTitle.trim().length === 0 ||
    metadata.seoTitle.length > 160
  ) {
    fields.seoTitle = "Use an SEO title between 1 and 160 characters.";
  }
  if (
    typeof metadata?.seoDescription !== "string" ||
    metadata.seoDescription.trim().length === 0 ||
    metadata.seoDescription.length > 320
  ) {
    fields.seoDescription =
      "Use an SEO description between 1 and 320 characters.";
  }
  if (Object.keys(fields).length > 0) {
    throw new BlogPostError("schema_invalid", fields);
  }
}

function validateInput(metadata: BlogPostMetadata, body: RichTextDocument) {
  validateMetadata(metadata);
  try {
    validateRichTextDocument(body);
  } catch {
    throw new BlogPostError("schema_invalid", {
      body: "Use schema-valid Foundry rich text.",
    });
  }
}

function randomId<Value extends string>(): Value {
  return crypto.randomUUID() as Value;
}

async function createRevision(input: {
  siteId: SiteId;
  postId: BlogPostId;
  number: number;
  metadata: BlogPostMetadata;
  body: RichTextDocument;
  actorId: BlogPostActorId;
  createdAt: string;
}): Promise<BlogPostRevision> {
  validateInput(input.metadata, input.body);
  const revisionId = randomId<BlogPostRevisionId>();
  const contentHash = await sha256CanonicalJson({
    format: blogPostSchemaVersion,
    siteId: input.siteId,
    postId: input.postId,
    metadata: input.metadata,
    body: input.body,
  });
  return freeze({
    id: revisionId,
    siteId: input.siteId,
    postId: input.postId,
    number: input.number,
    schemaVersion: blogPostSchemaVersion,
    metadata: structuredClone(input.metadata),
    body: structuredClone(input.body),
    contentHash,
    createdAt: input.createdAt,
    createdBy: input.actorId,
  });
}

function revision(record: BlogPostRecord, number: number) {
  const found = record.revisions.find((candidate) => candidate.number === number);
  if (found === undefined) {
    throw new BlogPostError("revision_not_current");
  }
  return found;
}

function replacePublication(
  record: BlogPostRecord,
  publication: BlogPostPublication,
): ReadonlyArray<BlogPostPublication> {
  return record.publications.map((candidate) =>
    candidate.id === publication.id ? publication : candidate
  );
}

export function createBlogPostApplication({
  siteId: configuredSiteId,
  store,
  pipeline,
  now = () => new Date().toISOString(),
}: {
  siteId: SiteId;
  store: BlogPostStore;
  pipeline: BlogPostPublicationPipeline;
  now?: () => string;
}) {
  if (pipeline.schemaVersion !== blogPostSchemaVersion) {
    throw new TypeError("blog_post_pipeline_schema_mismatch");
  }

  function assertSite(siteId: SiteId) {
    if (siteId !== configuredSiteId) {
      throw new BlogPostError("cross_site_identifier");
    }
  }

  async function artifactFor(postRevision: BlogPostRevision) {
    const richText = serializeRichTextDocument(postRevision.body);
    const artifact = `${canonicalJson({
      schemaVersion: postRevision.schemaVersion,
      postId: postRevision.postId,
      revisionId: postRevision.id,
      revisionNumber: postRevision.number,
      ...postRevision.metadata,
    })}\n${richText}`;
    const fingerprint = (await sha256CanonicalJson({
      format: "foundry.post-artifact-fingerprint.v1",
      siteId: postRevision.siteId,
      postId: postRevision.postId,
      revisionId: postRevision.id,
      revisionNumber: postRevision.number,
      contentHash: postRevision.contentHash,
      schemaVersion: pipeline.schemaVersion,
      rendererVersion: pipeline.rendererVersion,
      productionBase: pipeline.productionBase,
      channelConfigurationHash: pipeline.channelConfigurationHash,
      artifact,
    })) as PostArtifactFingerprint;
    return { artifact, fingerprint };
  }

  return Object.freeze({
    async create(input: {
      siteId: SiteId;
      postId: BlogPostId;
      actor: BlogPostActor;
      metadata: BlogPostMetadata;
      body: RichTextDocument;
    }) {
      assertSite(input.siteId);
      assertCanAuthor(input.actor);
      const createdAt = now();
      const firstRevision = await createRevision({
        siteId: input.siteId,
        postId: input.postId,
        number: 1,
        metadata: input.metadata,
        body: input.body,
        actorId: input.actor.id,
        createdAt,
      });
      const record = await store.create({
        post: {
          id: input.postId,
          siteId: input.siteId,
          version: 1,
          currentRevisionNumber: 1,
          liveRevisionNumber: null,
          workflow: "editing",
          activePublicationId: null,
        },
        revisions: [firstRevision],
        previews: [],
        approvals: [],
        publications: [],
      });
      return { post: record.post, revision: firstRevision };
    },

    async edit(input: {
      siteId: SiteId;
      postId: BlogPostId;
      actor: BlogPostActor;
      expectedVersion: number;
      metadata: BlogPostMetadata;
      body: RichTextDocument;
    }) {
      assertSite(input.siteId);
      assertCanAuthor(input.actor);
      const existing = await store.find(input.siteId, input.postId);
      if (existing === null) {
        throw new BlogPostError("post_not_found");
      }
      if (existing.post.activePublicationId !== null) {
        throw new BlogPostError("publication_in_progress");
      }
      const nextRevision = await createRevision({
        siteId: input.siteId,
        postId: input.postId,
        number: existing.post.currentRevisionNumber + 1,
        metadata: input.metadata,
        body: input.body,
        actorId: input.actor.id,
        createdAt: now(),
      });
      const invalidatedAt = now();
      const record = await store.update(
        input.siteId,
        input.postId,
        input.expectedVersion,
        (current) => ({
          ...current,
          post: {
            ...current.post,
            version: current.post.version + 1,
            currentRevisionNumber: nextRevision.number,
            workflow: "editing",
          },
          revisions: [...current.revisions, nextRevision],
          approvals: current.approvals.map((approval) =>
            approval.invalidatedAt === null
              ? { ...approval, invalidatedAt }
              : approval
          ),
        }),
      );
      return { post: record.post, revision: nextRevision };
    },

    async preview(input: {
      siteId: SiteId;
      postId: BlogPostId;
      revisionNumber: number;
      actor: BlogPostActor;
    }) {
      assertSite(input.siteId);
      assertCanAuthor(input.actor);
      const existing = await store.find(input.siteId, input.postId);
      if (existing === null) {
        throw new BlogPostError("post_not_found");
      }
      if (input.revisionNumber !== existing.post.currentRevisionNumber) {
        throw new BlogPostError("revision_not_current");
      }
      const currentRevision = revision(existing, input.revisionNumber);
      const rendered = await artifactFor(currentRevision);
      const preview: BlogPostPreview = freeze({
        revisionId: currentRevision.id,
        revisionNumber: currentRevision.number,
        fingerprint: rendered.fingerprint,
        rendererVersion: pipeline.rendererVersion,
        schemaVersion: pipeline.schemaVersion,
        artifact: rendered.artifact,
        createdAt: now(),
        createdBy: input.actor.id,
      });
      const record = await store.update(
        input.siteId,
        input.postId,
        existing.post.version,
        (current) => ({
          ...current,
          post: {
            ...current.post,
            version: current.post.version + 1,
            workflow: "approval_required",
          },
          previews: [...current.previews, preview],
        }),
      );
      return record.previews.at(-1)!;
    },

    async approve(input: {
      siteId: SiteId;
      postId: BlogPostId;
      actor: BlogPostActor;
      expectedVersion: number;
      revisionNumber: number;
      previewFingerprint: PostArtifactFingerprint;
    }) {
      assertSite(input.siteId);
      assertCanAuthorize(input.actor);
      const existing = await store.find(input.siteId, input.postId);
      if (existing === null) {
        throw new BlogPostError("post_not_found");
      }
      if (existing.post.currentRevisionNumber !== input.revisionNumber) {
        throw new BlogPostError("preview_stale");
      }
      const currentRevision = revision(existing, input.revisionNumber);
      const exact = await artifactFor(currentRevision);
      const preview = [...existing.previews].reverse().find(
        (candidate) =>
          candidate.revisionId === currentRevision.id &&
          candidate.fingerprint === input.previewFingerprint
      );
      if (preview === undefined) {
        throw new BlogPostError("preview_required");
      }
      if (exact.fingerprint !== input.previewFingerprint) {
        throw new BlogPostError("preview_stale");
      }
      const approval: BlogPostApproval = freeze({
        id: randomId<PostApprovalId>(),
        revisionId: currentRevision.id,
        revisionNumber: currentRevision.number,
        fingerprint: exact.fingerprint,
        approvedAt: now(),
        approvedBy: input.actor.id,
        invalidatedAt: null,
      });
      const record = await store.update(
        input.siteId,
        input.postId,
        input.expectedVersion,
        (current) => ({
          ...current,
          post: {
            ...current.post,
            version: current.post.version + 1,
            workflow: "approved",
          },
          approvals: [
            ...current.approvals.map((candidate) =>
              candidate.invalidatedAt === null
                ? { ...candidate, invalidatedAt: approval.approvedAt }
                : candidate
            ),
            approval,
          ],
        }),
      );
      return { post: record.post, approval };
    },

    async publish(input: {
      siteId: SiteId;
      postId: BlogPostId;
      actor: BlogPostActor;
      expectedVersion: number;
      approvalId: PostApprovalId;
      publicationId: PostPublicationId;
    }) {
      assertSite(input.siteId);
      assertCanAuthorize(input.actor);
      const existing = await store.find(input.siteId, input.postId);
      if (existing === null) {
        throw new BlogPostError("post_not_found");
      }
      if (existing.post.activePublicationId !== null) {
        throw new BlogPostError("publication_in_progress");
      }
      if (
        existing.publications.some(
          (candidate) => candidate.id === input.publicationId
        )
      ) {
        throw new BlogPostError("transition_forbidden");
      }
      const approval = existing.approvals.find(
        (candidate) => candidate.id === input.approvalId
      );
      const currentRevision = revision(
        existing,
        existing.post.currentRevisionNumber,
      );
      const exact = await artifactFor(currentRevision);
      if (
        approval === undefined ||
        approval.invalidatedAt !== null ||
        approval.revisionId !== currentRevision.id ||
        approval.fingerprint !== exact.fingerprint
      ) {
        throw new BlogPostError("approval_stale");
      }
      const requestedAt = now();
      const publication: BlogPostPublication = freeze({
        id: input.publicationId,
        siteId: input.siteId,
        postId: input.postId,
        kind: "publish",
        revisionId: currentRevision.id,
        revisionNumber: currentRevision.number,
        fingerprint: exact.fingerprint,
        attributedActorId: input.actor.id,
        requestedAt,
        status: "requested",
        receipt: null,
      });
      const claimed = await store.update(
        input.siteId,
        input.postId,
        input.expectedVersion,
        (current) => ({
          ...current,
          post: {
            ...current.post,
            version: current.post.version + 1,
            workflow: "executing",
            activePublicationId: publication.id,
          },
          publications: [...current.publications, publication],
        }),
      );
      try {
        const receipt = await pipeline.publish({
          publicationId: publication.id,
          siteId: input.siteId,
          postId: input.postId,
          kind: "publish",
          revisionId: currentRevision.id,
          revisionNumber: currentRevision.number,
          fingerprint: exact.fingerprint,
          artifact: exact.artifact,
          rendererVersion: pipeline.rendererVersion,
          schemaVersion: pipeline.schemaVersion,
          productionBase: pipeline.productionBase,
          channelConfigurationHash: pipeline.channelConfigurationHash,
          attributedActorId: input.actor.id,
        });
        if (
          receipt.publicationId !== publication.id ||
          receipt.fingerprint !== publication.fingerprint
        ) {
          throw new BlogPostError("publication_evidence_mismatch");
        }
        const deployed = { ...publication, status: "deployed" as const, receipt };
        const recorded = await store.updateExecution(
          input.siteId,
          input.postId,
          publication.id,
          (current) => ({
            ...current,
            publications: replacePublication(current, deployed),
          }),
        );
        return {
          post: recorded.post,
          publication: recorded.publications.find(
            (candidate) => candidate.id === publication.id
          )!,
        };
      } catch (error) {
        await store.updateExecution(
          input.siteId,
          input.postId,
          publication.id,
          (current) => ({
            ...current,
            post: {
              ...current.post,
              workflow: "approved",
              activePublicationId: null,
            },
            publications: replacePublication(current, {
              ...publication,
              status: "failed",
            }),
          }),
        );
        throw error;
      }
    },

    async unpublish(input: {
      siteId: SiteId;
      postId: BlogPostId;
      actor: BlogPostActor;
      expectedVersion: number;
      publicationId: PostPublicationId;
    }) {
      assertSite(input.siteId);
      assertCanAuthorize(input.actor);
      const existing = await store.find(input.siteId, input.postId);
      if (existing === null) {
        throw new BlogPostError("post_not_found");
      }
      if (existing.post.activePublicationId !== null) {
        throw new BlogPostError("publication_in_progress");
      }
      if (existing.post.liveRevisionNumber === null) {
        throw new BlogPostError("post_not_live");
      }
      if (
        existing.publications.some(
          (candidate) => candidate.id === input.publicationId
        )
      ) {
        throw new BlogPostError("transition_forbidden");
      }
      const liveRevision = revision(existing, existing.post.liveRevisionNumber);
      const liveArtifact = await artifactFor(liveRevision);
      const removalFingerprint = (await sha256CanonicalJson({
        format: "foundry.post-unpublish.v1",
        siteId: input.siteId,
        postId: input.postId,
        liveRevisionId: liveRevision.id,
        liveFingerprint: liveArtifact.fingerprint,
        rendererVersion: pipeline.rendererVersion,
        schemaVersion: pipeline.schemaVersion,
        productionBase: pipeline.productionBase,
        channelConfigurationHash: pipeline.channelConfigurationHash,
      })) as PostArtifactFingerprint;
      const publication: BlogPostPublication = freeze({
        id: input.publicationId,
        siteId: input.siteId,
        postId: input.postId,
        kind: "unpublish",
        revisionId: liveRevision.id,
        revisionNumber: liveRevision.number,
        fingerprint: removalFingerprint,
        attributedActorId: input.actor.id,
        requestedAt: now(),
        status: "requested",
        receipt: null,
      });
      await store.update(
        input.siteId,
        input.postId,
        input.expectedVersion,
        (current) => ({
          ...current,
          post: {
            ...current.post,
            version: current.post.version + 1,
            workflow: "executing",
            activePublicationId: publication.id,
          },
          publications: [...current.publications, publication],
        }),
      );
      try {
        const receipt = await pipeline.publish({
          publicationId: publication.id,
          siteId: input.siteId,
          postId: input.postId,
          kind: "unpublish",
          revisionId: liveRevision.id,
          revisionNumber: liveRevision.number,
          fingerprint: removalFingerprint,
          artifact: null,
          rendererVersion: pipeline.rendererVersion,
          schemaVersion: pipeline.schemaVersion,
          productionBase: pipeline.productionBase,
          channelConfigurationHash: pipeline.channelConfigurationHash,
          attributedActorId: input.actor.id,
        });
        if (
          receipt.publicationId !== publication.id ||
          receipt.fingerprint !== publication.fingerprint
        ) {
          throw new BlogPostError("publication_evidence_mismatch");
        }
        const deployed = { ...publication, status: "deployed" as const, receipt };
        const recorded = await store.updateExecution(
          input.siteId,
          input.postId,
          publication.id,
          (current) => ({
            ...current,
            publications: replacePublication(current, deployed),
          }),
        );
        return {
          post: recorded.post,
          publication: recorded.publications.find(
            (candidate) => candidate.id === publication.id
          )!,
        };
      } catch (error) {
        await store.updateExecution(
          input.siteId,
          input.postId,
          publication.id,
          (current) => ({
            ...current,
            post: {
              ...current.post,
              workflow:
                current.post.currentRevisionNumber ===
                current.post.liveRevisionNumber
                  ? "approved"
                  : "editing",
              activePublicationId: null,
            },
            publications: replacePublication(current, {
              ...publication,
              status: "failed",
            }),
          }),
        );
        throw error;
      }
    },

    async verifyPublication(input: {
      siteId: SiteId;
      postId: BlogPostId;
      publicationId: PostPublicationId;
      expectedVersion: number;
    }) {
      assertSite(input.siteId);
      const existing = await store.find(input.siteId, input.postId);
      if (existing === null) {
        throw new BlogPostError("post_not_found");
      }
      const publication = existing.publications.find(
        (candidate) => candidate.id === input.publicationId
      );
      if (
        publication === undefined ||
        publication.status !== "deployed" ||
        publication.receipt === null ||
        existing.post.activePublicationId !== publication.id
      ) {
        throw new BlogPostError("publication_not_found");
      }
      const evidence = await pipeline.verifyLive(publication.receipt);
      if (
        !evidence.live ||
        evidence.publicationId !== publication.id ||
        evidence.fingerprint !== publication.fingerprint
      ) {
        throw new BlogPostError("publication_evidence_mismatch");
      }
      const verified = {
        ...publication,
        status: "verified-live" as const,
      };
      const record = await store.update(
        input.siteId,
        input.postId,
        input.expectedVersion,
        (current) => ({
          ...current,
          post: {
            ...current.post,
            version: current.post.version + 1,
            liveRevisionNumber:
              publication.kind === "publish"
                ? publication.revisionNumber
                : null,
            workflow:
              current.post.currentRevisionNumber === publication.revisionNumber
                ? "approved"
                : "editing",
            activePublicationId: null,
          },
          publications: replacePublication(current, verified),
        }),
      );
      return {
        post: record.post,
        publication: record.publications.find(
          (candidate) => candidate.id === publication.id
        )!,
      };
    },

    async get(siteId: SiteId, postId: BlogPostId) {
      assertSite(siteId);
      return (await store.find(siteId, postId))?.post ?? null;
    },

    async getRevision(siteId: SiteId, postId: BlogPostId, number: number) {
      assertSite(siteId);
      const record = await store.find(siteId, postId);
      return record?.revisions.find((candidate) => candidate.number === number)
        ?? null;
    },

    async listPublications(siteId: SiteId, postId: BlogPostId) {
      assertSite(siteId);
      return (await store.find(siteId, postId))?.publications ?? [];
    },
  });
}
