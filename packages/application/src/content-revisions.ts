import {
  addPageToDefinition,
  applyPageComposition,
  applySiteDefinitionEdits,
  bindSiteMediaOccurrence,
  blogPostIdsForSiteDefinitionEdits,
  duplicatePageInDefinition,
  findPageById,
  mintedPageId,
  removePageFromDefinition,
  PageLifecycleError,
  type PageLifecycleErrorCode,
  type PageLinkReference,
  createBlogPostDefinition,
  editBlogPostDefinition,
  republishBlogPostDefinition,
  unpublishBlogPostDefinition,
  BlogPostSchemaError,
  foundationPageComponentRegistry,
  findPageByCompositionSlotId,
  homePage,
  isSiteDefinitionWithPageComponents,
  pageFieldPath,
  sectionVariantFieldPath,
  type BlogPost,
  type BlogPostId,
  type PageComposition,
  type PageComponentRegistry,
  type SiteDefinition,
  type SiteDefinitionEdit,
  type SitePage,
  type StoredSiteDefinitionSchemaVersion,
  type SiteMediaOccurrence,
} from "@humber-foundry/site-definition";
import { sha256CanonicalJson } from "./deterministic-hash";
import {
  createBlogPostArtifactFingerprint,
  createBlogPostArtifactFingerprints,
  type BlogPostArtifactFingerprint,
} from "./blog-artifacts";

export type ContentRevisionInputs = Readonly<{
  contentHash: string;
  schemaVersion: StoredSiteDefinitionSchemaVersion;
  rendererVersion: string;
  productionBase: string;
}>;

declare const contentWorkspaceIdBrand: unique symbol;
export type ContentWorkspaceId = string & {
  readonly [contentWorkspaceIdBrand]: "ContentWorkspaceId";
};

export function createContentWorkspaceId(value: string): ContentWorkspaceId {
  if (!/^workspace_[a-z0-9_]+$/.test(value)) {
    throw new TypeError("content_workspace_id_invalid");
  }
  return value as ContentWorkspaceId;
}

declare const contentActorIdBrand: unique symbol;
export type ContentActorId = string & {
  readonly [contentActorIdBrand]: "ContentActorId";
};

export const publishedBaseContentActorId =
  "system:published-base" as ContentActorId;

export function createContentActorId(value: string): ContentActorId {
  if (!/^(?:membership|mcp|integration)[-_][A-Za-z0-9._:-]+$/.test(value)) {
    throw new TypeError("content_actor_id_invalid");
  }
  return value as ContentActorId;
}

export function restoreContentActorId(value: string): ContentActorId {
  return value === publishedBaseContentActorId
    ? publishedBaseContentActorId
    : createContentActorId(value);
}

export type ContentRevision = Readonly<{
  workspaceId: ContentWorkspaceId;
  revision: number;
  definition: SiteDefinition;
  inputs: ContentRevisionInputs;
  createdAt: string;
  createdBy: ContentActorId;
}>;

export type SavedContentRevision = ContentRevision &
  Readonly<{ bookmark: string }>;

export type JoinedMcpMutationAudit = Readonly<{
  invocationId: string;
  connectionId: string;
  actorId: string;
  siteId: SiteDefinition["site"]["id"];
  operation: string;
  inputHash: string;
  protocolVersion: string;
  scopesEvaluated: ReadonlyArray<string>;
  idempotencyKey: string;
  occurredAt: string;
  contractVersion: string;
}>;

export type JoinedMcpMutationResult = Readonly<{
  resultHash: string;
  workspaceId: ContentWorkspaceId;
  revision: number;
  contentHash: string;
  previewId?: string;
}>;

export type SaveContentRevisionCommand = Readonly<{
  actorId: ContentActorId;
  workspaceId: ContentWorkspaceId;
  schemaVersion: SiteDefinition["schemaVersion"];
  baseRevision: number;
  edits: ReadonlyArray<SiteDefinitionEdit>;
  /**
   * The structural change of each page whose sections changed, at most one per
   * page. Each composition names its own page through its `slotId`, so a save
   * that carries several pages writes each one onto the page it belongs to.
   */
  compositions?: ReadonlyArray<PageComposition>;
  idempotencyKey: string;
  joinedAudit?: JoinedMcpMutationAudit;
}>;

type BlogPostMutationCommand = Readonly<{
  actorId: ContentActorId;
  workspaceId: ContentWorkspaceId;
  siteId: SiteDefinition["site"]["id"];
  schemaVersion: SiteDefinition["schemaVersion"];
  baseRevision: number;
  idempotencyKey: string;
}>;

export type CreateBlogPostCommand = BlogPostMutationCommand &
  Readonly<{
    post: Omit<
      BlogPost,
      "revision" | "collectionState" | "targetVisibility"
    >;
  }>;

export type EditBlogPostCommand = BlogPostMutationCommand &
  Readonly<{
    postId: BlogPostId;
    post: Omit<
      BlogPost,
      "id" | "revision" | "collectionState" | "targetVisibility"
    >;
  }>;

export type UnpublishBlogPostCommand = BlogPostMutationCommand &
  Readonly<{ postId: BlogPostId }>;
export type RepublishBlogPostCommand = BlogPostMutationCommand &
  Readonly<{ postId: BlogPostId }>;

type BlogPostAuditState = Readonly<{
  revision: number;
  targetVisibility: BlogPost["targetVisibility"];
  aggregateRevision?: number;
  liveRevision?: number | null;
  aggregateVersion?: number;
}> | null;

type BlogPostTransitionAudit = Readonly<{
  postId: BlogPostId | null;
  commandType:
    | "blog.post.create"
    | "blog.post.edit"
    | "blog.post.unpublish"
    | "blog.post.republish";
  requestId: string;
  reasonCode: string;
  beforeState: BlogPostAuditState;
  afterState: BlogPostAuditState;
  occurredAt: string;
}>;

type BlogPostAggregateState = Readonly<{
  currentRevision: number;
  liveRevision: number | null;
  lastVerifiedRevision: number | null;
  lastVerifiedVisibility: BlogPost["targetVisibility"] | "absent" | null;
  version: number;
}>;

/**
 * Keep each section's stored style unless this save also edits that style.
 *
 * `page` is the page the composition belongs to. A section style is an
 * editable field of its page, so its field path carries the page id on every
 * page below the home page. Reading the style through the page keeps two pages
 * that hold sections with the same id apart.
 *
 * This is exported because it is the seam ticket #158 uses when the editor
 * composes a page other than the home page. Until then the one caller inside
 * this module passes the home page.
 */
export function compositionWithStoredSectionStyles(
  page: SitePage,
  composition: PageComposition,
  edits: ReadonlyArray<SiteDefinitionEdit>,
): PageComposition {
  const existingById = new Map(
    page.sections.map((section) => [section.id, section]),
  );
  const variantEdits = new Map(
    edits
      .filter(({ path }) => path.endsWith(".variant"))
      .map(({ path, value }) => [path, value]),
  );
  return {
    ...composition,
    components: composition.components.map((component) => {
      const existing = existingById.get(component.id);
      if (
        existing === undefined ||
        variantEdits.get(
          pageFieldPath(page, sectionVariantFieldPath(component.id)),
        ) !== component.variant
      ) {
        return component;
      }
      if (component.type === "hero" && existing.type === "hero") {
        return { ...component, variant: existing.variant };
      }
      if (
        component.type === "services" &&
        existing.type === "services"
      ) {
        return { ...component, variant: existing.variant };
      }
      if (component.type === "proof" && existing.type === "proof") {
        return { ...component, variant: existing.variant };
      }
      if (
        component.type === "callToAction" &&
        existing.type === "callToAction"
      ) {
        return { ...component, variant: existing.variant };
      }
      return component;
    }),
  };
}

/**
 * What every page operation needs, whoever asks for it.
 *
 * These are the same five things every other content operation takes: who is
 * asking, which draft, which schema, which revision they read before they
 * decided, and the key that makes a retry safe. The dashboard sends them
 * through the revisions route; the MCP page tools (#161) send them directly.
 * There is one implementation, so both refuse for the same reasons.
 */
export type PageMutationCommand = Readonly<{
  actorId: ContentActorId;
  workspaceId: ContentWorkspaceId;
  schemaVersion: SiteDefinition["schemaVersion"];
  baseRevision: number;
  idempotencyKey: string;
  joinedAudit?: JoinedMcpMutationAudit;
}>;

export type CreatePageCommand = PageMutationCommand &
  Readonly<{
    title: string;
    slug: string;
    /** One of the ids in `pageStartingLayouts`, such as `blank`. */
    startingLayout: string;
  }>;

export type RenamePageCommand = PageMutationCommand &
  Readonly<{ pageId: string; title: string; slug: string }>;

export type DuplicatePageCommand = PageMutationCommand &
  Readonly<{ pageId: string; title: string; slug: string }>;

export type DeletePageCommand = PageMutationCommand &
  Readonly<{ pageId: string }>;

/**
 * What a page operation gives back.
 *
 * `pageId` is the page the operation acted on: the new page for a create or a
 * duplicate, the named page for a rename or a delete. `replayed` is true when
 * this exact request had already been carried out, in which case no second
 * page was made and no second revision was written.
 */
export type PageMutationResult = Readonly<{
  revision: SavedContentRevision;
  pageId: string;
  replayed: boolean;
}>;

export type CreateContentWorkspaceCommand = Readonly<{
  actorId: ContentActorId;
  workspaceId: ContentWorkspaceId;
  idempotencyKey: string;
  joinedAudit?: JoinedMcpMutationAudit;
}>;

export type SaveContentMediaOccurrenceCommand = Readonly<{
  actorId: ContentActorId;
  workspaceId: ContentWorkspaceId;
  schemaVersion: SiteDefinition["schemaVersion"];
  baseRevision: number;
  occurrence: SiteMediaOccurrence;
  idempotencyKey: string;
}>;

export function isValidContentMutationIdempotencyKey(
  value: string,
): boolean {
  return /^[A-Za-z0-9._:-]{16,128}$/u.test(value);
}

type PersistContentRevisionCommand = Readonly<{
  baseRevision: number;
  idempotencyKey: string;
  requestHash: string;
  revision: ContentRevision;
  mediaOccurrence?: Readonly<{
    occurrenceId: SiteMediaOccurrence["occurrenceId"];
    revision: number;
    assetId: string;
    crop: SiteMediaOccurrence["crop"];
  }>;
  blogTransitions?: ReadonlyArray<
    Omit<BlogPostTransitionAudit, "reasonCode" | "postId"> &
      Readonly<{
        postId: BlogPostId;
        revisionId: string;
        artifact: BlogPostArtifactFingerprint;
        observedAggregate: BlogPostAggregateState | null;
      }>
  >;
  blogArtifacts: ReadonlyArray<BlogPostArtifactFingerprint>;
  joinedAudit?: JoinedMcpMutationAudit;
}>;

export type ContentRevisionStore = Readonly<{
  initialize(
    initialRevision: ContentRevision,
    ownerActorId: ContentActorId,
    joinedAudit?: JoinedMcpMutationAudit,
  ): Promise<boolean>;
  requireAccess(actorId: ContentActorId): Promise<void>;
  addCollaborator(
    ownerActorId: ContentActorId,
    collaboratorActorId: ContentActorId,
  ): Promise<void>;
  replay(
    idempotencyKey: string,
    requestHash: string,
  ): Promise<SavedContentRevision | null>;
  getCurrent(): Promise<ContentRevision>;
  getRevision(
    revision: number,
    bookmark?: string,
  ): Promise<ContentRevision | null>;
  getRevisionWithBookmark(
    revision: number,
  ): Promise<SavedContentRevision | null>;
  getBlogPostAggregate(
    postId: BlogPostId,
  ): Promise<BlogPostAggregateState | null>;
  persist(
    command: PersistContentRevisionCommand,
  ): Promise<
    Readonly<{
      revision: SavedContentRevision;
      replayed: boolean;
    }>
  >;
  recordRejectedBlogTransition(input: {
    workspaceId: ContentWorkspaceId;
    actorId: ContentActorId;
  } & BlogPostTransitionAudit): Promise<void>;
  recordJoinedMcpAudit(
    audit: JoinedMcpMutationAudit,
    result: JoinedMcpMutationResult,
  ): Promise<void>;
}>;

export class ContentRevisionConflictError extends Error {
  readonly currentRevision: number;

  constructor(currentRevision: number) {
    super("content_revision_conflict");
    this.name = "ContentRevisionConflictError";
    this.currentRevision = currentRevision;
  }
}

export class ContentRevisionIdempotencyError extends Error {
  constructor() {
    super("content_revision_idempotency_key_conflict");
    this.name = "ContentRevisionIdempotencyError";
  }
}

export class ContentRevisionValidationError extends Error {
  readonly fields: Readonly<Record<string, string>>;

  constructor(fields: Readonly<Record<string, string>>) {
    super("content_revision_validation_failed");
    this.name = "ContentRevisionValidationError";
    this.fields = fields;
  }
}

/**
 * A page operation the draft refused.
 *
 * It is a validation failure like any other, so every caller that already
 * handles `ContentRevisionValidationError` answers it with the same 422 and
 * the same per-field sentences. It carries two extra things for a caller that
 * wants them: `code`, the stable word a program reads, and `references`, the
 * links that still point at a page whose delete was refused. The dashboard
 * uses `references` to name those links and offer to open them; the MCP page
 * tools (#161) read `code`.
 */
export class ContentPageOperationError extends ContentRevisionValidationError {
  readonly code: PageLifecycleErrorCode;
  readonly references: ReadonlyArray<PageLinkReference>;

  constructor(error: PageLifecycleError) {
    super(error.fields);
    this.name = "ContentPageOperationError";
    this.code = error.code;
    this.references = error.references;
  }
}

export class ContentRevisionConfigurationError extends Error {
  constructor() {
    super("content_revision_not_configured");
    this.name = "ContentRevisionConfigurationError";
  }
}

export class ContentWorkspaceAccessError extends Error {
  constructor() {
    super("content_workspace_access_denied");
    this.name = "ContentWorkspaceAccessError";
  }
}

export class ContentRevisionStaleError extends Error {
  readonly acknowledgedRevision: number | undefined;

  constructor(acknowledgedRevision?: number) {
    super("content_revision_stale");
    this.name = "ContentRevisionStaleError";
    this.acknowledgedRevision = acknowledgedRevision;
  }
}

export class ContentRevisionBookmarkError extends Error {
  constructor() {
    super("content_revision_bookmark_invalid");
    this.name = "ContentRevisionBookmarkError";
  }
}

export function assertContentRevisionIdempotency(
  recordedRequestHash: string,
  requestHash: string,
): void {
  if (recordedRequestHash !== requestHash) {
    throw new ContentRevisionIdempotencyError();
  }
}

export function assertContentRevisionBase(
  baseRevision: number,
  currentRevision: number,
): void {
  if (baseRevision !== currentRevision) {
    throw new ContentRevisionConflictError(currentRevision);
  }
}

export function withContentRevisionBookmark(
  revision: ContentRevision,
  bookmark: string,
): SavedContentRevision {
  return { ...revision, bookmark };
}

export function isContentRevisionRenderableBy(
  revision: ContentRevision,
  inputs: Readonly<{
    schemaVersion: SiteDefinition["schemaVersion"];
    rendererVersion: string;
    productionBase: string;
  }>,
): boolean {
  return (
    revision.inputs.schemaVersion === inputs.schemaVersion &&
    revision.inputs.rendererVersion === inputs.rendererVersion &&
    revision.inputs.productionBase === inputs.productionBase
  );
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function immutableRevision(revision: ContentRevision): ContentRevision {
  return deepFreeze(structuredClone(revision));
}

export type InMemoryMediaContentCoordinator = Readonly<{
  runExclusive<Value>(operation: () => Promise<Value>): Promise<Value>;
}>;

export function createInMemoryMediaContentCoordinator(): InMemoryMediaContentCoordinator {
  let tail = Promise.resolve();

  return Object.freeze({
    async runExclusive<Value>(operation: () => Promise<Value>): Promise<Value> {
      const previous = tail;
      let release = () => {};
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    },
  });
}

export function createInMemoryContentRevisionStore({
  isMediaOccurrenceCurrent = async () => true,
  mediaContentCoordinator,
}: {
  isMediaOccurrenceCurrent?: (
    occurrence: NonNullable<PersistContentRevisionCommand["mediaOccurrence"]>,
  ) => Promise<boolean>;
  mediaContentCoordinator?: InMemoryMediaContentCoordinator;
} = {}): ContentRevisionStore {
  const revisions = new Map<number, ContentRevision>();
  const receipts = new Map<
    string,
    Readonly<{ requestHash: string; revision: SavedContentRevision }>
  >();
  let currentRevision = 0;
  let ownerActorId: ContentActorId | undefined;
  const collaborators = new Set<ContentActorId>();
  const blogPosts = new Map<BlogPostId, BlogPostAggregateState>();

  return {
    async initialize(initialRevision, initialOwnerActorId) {
      if (revisions.size === 0) {
        const immutable = immutableRevision(initialRevision);
        revisions.set(immutable.revision, immutable);
        currentRevision = immutable.revision;
        ownerActorId = initialOwnerActorId;
        for (const post of initialRevision.definition.blog.posts) {
          blogPosts.set(post.id, {
            currentRevision: post.revision,
            liveRevision:
              post.targetVisibility === "public" ? post.revision : null,
            lastVerifiedRevision: post.revision,
            lastVerifiedVisibility: post.targetVisibility,
            version: post.revision,
          });
        }
        return true;
      }
      return false;
    },
    async requireAccess(actorId) {
      if (actorId !== ownerActorId && !collaborators.has(actorId)) {
        throw new ContentWorkspaceAccessError();
      }
    },
    async addCollaborator(actorId, collaboratorActorId) {
      if (actorId !== ownerActorId) {
        throw new ContentWorkspaceAccessError();
      }
      collaborators.add(collaboratorActorId);
    },
    async getCurrent() {
      return revisions.get(currentRevision)!;
    },
    async getRevision(revision) {
      return revisions.get(revision) ?? null;
    },
    async getRevisionWithBookmark(revisionNumber) {
      const revision = revisions.get(revisionNumber);
      return revision === undefined
        ? null
        : withContentRevisionBookmark(
            revision,
            `local:${revision.workspaceId}:${revision.revision}`,
          );
    },
    async getBlogPostAggregate(postId) {
      return blogPosts.get(postId) ?? null;
    },
    async recordRejectedBlogTransition() {},
    async recordJoinedMcpAudit() {},
    async replay(idempotencyKey, requestHash) {
      const receipt = receipts.get(idempotencyKey);
      if (receipt === undefined) {
        return null;
      }
      assertContentRevisionIdempotency(receipt.requestHash, requestHash);
      return receipt.revision;
    },
    persist(command) {
      const operation = async () => {
        const receipt = receipts.get(command.idempotencyKey);
        if (receipt !== undefined) {
          assertContentRevisionIdempotency(
            receipt.requestHash,
            command.requestHash,
          );
          return { revision: receipt.revision, replayed: true };
        }
        assertContentRevisionBase(command.baseRevision, currentRevision);
        if (
          command.mediaOccurrence !== undefined &&
          !(await isMediaOccurrenceCurrent(command.mediaOccurrence))
        ) {
          throw new ContentRevisionConflictError(currentRevision);
        }
        for (const transition of command.blogTransitions ?? []) {
          const aggregate = blogPosts.get(transition.postId);
          if (
            (transition.beforeState === null &&
              (transition.observedAggregate !== null ||
                aggregate !== undefined)) ||
            (transition.beforeState !== null &&
              (transition.observedAggregate === null ||
                aggregate === undefined ||
                aggregate.currentRevision !==
                  transition.observedAggregate.currentRevision ||
                aggregate.liveRevision !==
                  transition.observedAggregate.liveRevision ||
                aggregate.lastVerifiedRevision !==
                  transition.observedAggregate.lastVerifiedRevision ||
                aggregate.lastVerifiedVisibility !==
                  transition.observedAggregate.lastVerifiedVisibility ||
                aggregate.version !== transition.observedAggregate.version))
          ) {
            throw new ContentRevisionConflictError(currentRevision);
          }
        }
        const revision = immutableRevision(command.revision);
        const saved = deepFreeze(
          withContentRevisionBookmark(
            revision,
            `local:${revision.workspaceId}:${revision.revision}`,
          ),
        );
        revisions.set(revision.revision, revision);
        currentRevision = revision.revision;
        receipts.set(command.idempotencyKey, {
          requestHash: command.requestHash,
          revision: saved,
        });
        for (const transition of command.blogTransitions ?? []) {
          if (transition.beforeState === null) {
            blogPosts.set(transition.postId, {
              currentRevision: transition.afterState!.revision,
              liveRevision: null,
              lastVerifiedRevision: null,
              lastVerifiedVisibility: null,
              version: 1,
            });
          }
        }
        return { revision: saved, replayed: false };
      };
      return mediaContentCoordinator !== undefined
        ? mediaContentCoordinator.runExclusive(operation)
        : operation();
    },
  };
}

export function createContentRevisionApplication({
  siteDefinition,
  initialDefinition = siteDefinition,
  initialCreatedBy = publishedBaseContentActorId,
  store,
  workspaceId,
  actorId,
  rendererVersion,
  productionBase,
  pageComponents = foundationPageComponentRegistry,
  isDefinition = (value): value is SiteDefinition =>
    isSiteDefinitionWithPageComponents(value, pageComponents),
  now = () => new Date().toISOString(),
}: {
  siteDefinition: SiteDefinition;
  initialDefinition?: SiteDefinition;
  initialCreatedBy?: ContentActorId;
  store: ContentRevisionStore;
  workspaceId: ContentWorkspaceId;
  actorId: ContentActorId;
  rendererVersion: string;
  productionBase: string | ((publishedContentHash: string) => string);
  pageComponents?: PageComponentRegistry;
  isDefinition?: (value: unknown) => value is SiteDefinition;
  now?: () => string;
}) {
  let initialization: Promise<boolean> | undefined;
  let productionBaseResolution: Promise<string> | undefined;
  const resolveProductionBase = () => {
    productionBaseResolution ??= (async () => {
      const publishedContentHash = await sha256CanonicalJson(siteDefinition);
      return typeof productionBase === "function"
        ? productionBase(publishedContentHash)
        : productionBase;
    })();
    return productionBaseResolution;
  };
  const initialize = (joinedAudit?: JoinedMcpMutationAudit) => {
    initialization ??= (async () => {
      const publishedContentHash =
        await sha256CanonicalJson(initialDefinition);
      const resolvedProductionBase = await resolveProductionBase();
      const initial = immutableRevision({
        workspaceId,
        revision: 0,
        definition: initialDefinition,
        inputs: {
          contentHash: publishedContentHash,
          schemaVersion: siteDefinition.schemaVersion,
          rendererVersion,
          productionBase: resolvedProductionBase,
        },
        createdAt: now(),
        createdBy: initialCreatedBy,
      });
      const created = await store.initialize(initial, actorId, joinedAudit);
      await store.requireAccess(actorId);
      return created;
    })();
    return initialization;
  };

  function assertMutationCommand(command: {
    actorId: ContentActorId;
    workspaceId: ContentWorkspaceId;
    idempotencyKey: string;
  }) {
    if (command.actorId !== actorId) {
      throw new ContentWorkspaceAccessError();
    }
    if (!isValidContentMutationIdempotencyKey(command.idempotencyKey)) {
      throw new ContentRevisionValidationError({
        idempotencyKey: "Use a 16–128 character idempotency key.",
      });
    }
    if (command.workspaceId !== workspaceId) {
      throw new ContentRevisionValidationError({
        workspaceId: "This workspace is not available.",
      });
    }
  }

  async function persistDefinitionMutationWithReplay(input: {
    command: {
      actorId: ContentActorId;
      schemaVersion: SiteDefinition["schemaVersion"];
      baseRevision: number;
      idempotencyKey: string;
      joinedAudit?: JoinedMcpMutationAudit;
    };
    requestIdentity: unknown;
    mutate(
      base: SiteDefinition,
      observedBlogAggregates: ReadonlyMap<
        BlogPostId,
        BlogPostAggregateState | null
      >,
    ): SiteDefinition | Promise<SiteDefinition>;
    blogTransitions?: ReadonlyArray<Readonly<{
      postId: BlogPostId;
      commandType: BlogPostTransitionAudit["commandType"];
    }>>;
  }) {
    await store.requireAccess(actorId);
    const currentProductionBase = await resolveProductionBase();
    const requestHash = await sha256CanonicalJson(input.requestIdentity);
    const replay = await store.replay(
      input.command.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      if (
        !isContentRevisionRenderableBy(replay, {
          schemaVersion: siteDefinition.schemaVersion,
          rendererVersion,
          productionBase: currentProductionBase,
        })
      ) {
        throw new ContentRevisionStaleError(replay.revision);
      }
      if (input.command.joinedAudit !== undefined) {
        await store.recordJoinedMcpAudit(input.command.joinedAudit, {
          resultHash: replay.inputs.contentHash,
          workspaceId: replay.workspaceId,
          revision: replay.revision,
          contentHash: replay.inputs.contentHash,
        });
      }
      return { revision: replay, replayed: true as const };
    }
    if (input.command.schemaVersion !== siteDefinition.schemaVersion) {
      throw new ContentRevisionValidationError({
        schemaVersion:
          `Use Site Definition schema ${siteDefinition.schemaVersion}.`,
      });
    }
    const base = await store.getRevision(input.command.baseRevision);
    if (base === null) {
      const current = await store.getCurrent();
      throw new ContentRevisionConflictError(current.revision);
    }
    if (
      !isContentRevisionRenderableBy(base, {
        schemaVersion: siteDefinition.schemaVersion,
        rendererVersion,
        productionBase: currentProductionBase,
      })
    ) {
      throw new ContentRevisionStaleError();
    }
    const observedBlogAggregates = new Map<
      BlogPostId,
      BlogPostAggregateState | null
    >(
      await Promise.all(
        (input.blogTransitions ?? []).map(async ({ postId }) => [
          postId,
          await store.getBlogPostAggregate(postId),
        ] as const),
      ),
    );
    let definition: SiteDefinition;
    try {
      definition = await input.mutate(
        base.definition,
        observedBlogAggregates,
      );
    } catch (error) {
      if (error instanceof BlogPostSchemaError) {
        throw new ContentRevisionValidationError({
          blog: error.code,
        });
      }
      throw error;
    }
    const nextRevision: ContentRevision = {
      workspaceId,
      revision: input.command.baseRevision + 1,
      definition,
      inputs: {
        contentHash: await sha256CanonicalJson(definition),
        schemaVersion: definition.schemaVersion,
        rendererVersion,
        productionBase: base.inputs.productionBase,
      },
      createdAt: now(),
      createdBy: input.command.actorId,
    };
    const blogTransitions =
      input.blogTransitions === undefined
        ? undefined
        : await Promise.all(
            input.blogTransitions.map(async (transition) => {
              const post = definition.blog.posts.find(
                ({ id }) => id === transition.postId,
              );
              if (post === undefined) {
                throw new ContentRevisionConfigurationError();
              }
              const artifact = await createBlogPostArtifactFingerprint({
                definition,
                post,
                schemaVersion: definition.schemaVersion,
                rendererVersion,
              });
              return {
                ...transition,
                revisionId: artifact.postRevisionId,
                artifact,
                observedAggregate:
                  observedBlogAggregates.get(transition.postId) ?? null,
                requestId: input.command.idempotencyKey,
                beforeState: blogPostAuditState(
                  base.definition,
                  transition.postId,
                ),
                afterState: blogPostAuditState(
                  definition,
                  transition.postId,
                ),
                occurredAt: nextRevision.createdAt,
              };
            }),
          );
    const blogArtifacts = await createBlogPostArtifactFingerprints({
      definition,
      inputs: {
        schemaVersion: definition.schemaVersion,
        rendererVersion,
      },
    });
    const persisted = await store.persist({
      baseRevision: input.command.baseRevision,
      idempotencyKey: input.command.idempotencyKey,
      requestHash,
      revision: nextRevision,
      blogArtifacts,
      ...(blogTransitions === undefined ? {} : { blogTransitions }),
      ...(input.command.joinedAudit === undefined
        ? {}
        : { joinedAudit: input.command.joinedAudit }),
    });
    return persisted;
  }

  async function persistDefinitionMutation(
    input: Parameters<typeof persistDefinitionMutationWithReplay>[0],
  ) {
    return (await persistDefinitionMutationWithReplay(input)).revision;
  }

  function blogPostAuditState(
    definition: SiteDefinition,
    postId: BlogPostId,
  ): BlogPostAuditState {
    const post = definition.blog.posts.find(({ id }) => id === postId);
    return post === undefined
      ? null
      : { revision: post.revision, targetVisibility: post.targetVisibility };
  }

  function blogAuditRequestId(value: string): string {
    return isValidContentMutationIdempotencyKey(value)
      ? value
      : `invalid:${crypto.randomUUID()}`;
  }

  async function executeBlogMutation<Result>(
    commandType: BlogPostTransitionAudit["commandType"],
    command: Pick<
      BlogPostMutationCommand,
      | "actorId"
      | "workspaceId"
      | "schemaVersion"
      | "baseRevision"
      | "idempotencyKey"
    >,
    postIds: ReadonlyArray<BlogPostId>,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    if (
      command.actorId !== actorId ||
      command.workspaceId !== workspaceId
    ) {
      throw new ContentWorkspaceAccessError();
    }
    await store.requireAccess(actorId);
    try {
      assertMutationCommand(command);
      return await operation();
    } catch (error) {
      let currentDefinition: SiteDefinition | null = null;
      try {
        currentDefinition = (await store.getCurrent()).definition;
      } catch {
        // Rejection audit remains valid when no workspace revision exists.
      }
      for (const postId of postIds) {
        const aggregate = await store.getBlogPostAggregate(postId);
        const snapshot =
          currentDefinition === null
            ? null
            : blogPostAuditState(currentDefinition, postId);
        const beforeState =
          snapshot === null || aggregate === null
            ? snapshot
            : {
                ...snapshot,
                aggregateRevision: aggregate.currentRevision,
                liveRevision: aggregate.liveRevision,
                aggregateVersion: aggregate.version,
              };
        await store.recordRejectedBlogTransition({
          workspaceId,
          actorId,
          postId,
          commandType,
          reasonCode:
            error instanceof ContentRevisionValidationError &&
            typeof error.fields.blog === "string"
              ? error.fields.blog
              : error instanceof Error && /^[a-z0-9_]+$/u.test(error.message)
                ? error.message
                : "blog_post_command_rejected",
          requestId: blogAuditRequestId(command.idempotencyKey),
          beforeState,
          afterState: beforeState,
          occurredAt: now(),
        });
      }
      throw error;
    }
  }

  async function saveDefinitionMutation(command: SaveContentRevisionCommand) {
    if (command.actorId !== actorId) {
      throw new ContentWorkspaceAccessError();
    }
    if (command.workspaceId !== workspaceId) {
      throw new ContentRevisionValidationError({
        workspaceId: "This workspace is not available.",
      });
    }
    await store.requireAccess(actorId);
    const requestedBase = await store.getRevision(command.baseRevision);
    const fieldDefinition =
      requestedBase?.definition ?? (await store.getCurrent()).definition;
    const blogPostIds = blogPostIdsForSiteDefinitionEdits(
      fieldDefinition,
      command.edits,
    );
    const operation = () =>
      persistDefinitionMutationWithReplay({
        command,
        requestIdentity: {
          actorId: command.actorId,
          workspaceId: command.workspaceId,
          schemaVersion: command.schemaVersion,
          baseRevision: command.baseRevision,
          edits: command.edits,
          ...(command.compositions === undefined ||
          command.compositions.length === 0
            ? {}
            : { compositions: command.compositions }),
        },
        mutate(baseDefinition) {
          // Each composition names its page through its slot id, so a save
          // that carries two pages writes each one onto its own page and
          // cannot move a section from one page to another.
          let composedDefinition = baseDefinition;
          for (const composition of command.compositions ?? []) {
            const page = findPageByCompositionSlotId(
              composedDefinition,
              composition.slotId,
            );
            if (page === undefined) {
              // Either this site has no such page, or two pages claim the
              // slot and there is no single right answer. Both are refused,
              // because writing the sections onto a guessed page would change
              // a page the owner never edited.
              throw new ContentRevisionValidationError({
                [composition.slotId]:
                  "This site has no one page for these sections.",
              });
            }
            const composed = applyPageComposition(
              composedDefinition,
              page,
              compositionWithStoredSectionStyles(
                page,
                composition,
                command.edits,
              ),
              pageComponents,
            );
            if (!composed.ok) {
              throw new ContentRevisionValidationError(composed.errors);
            }
            composedDefinition = composed.definition;
          }
          const edited = applySiteDefinitionEdits(
            composedDefinition,
            command.edits,
            isDefinition,
          );
          if (!edited.ok) {
            throw new ContentRevisionValidationError(edited.errors);
          }
          return edited.definition;
        },
        ...(blogPostIds.length === 0
          ? {}
          : {
              blogTransitions: blogPostIds.map((postId) => ({
                commandType: "blog.post.edit" as const,
                postId,
              })),
            }),
      });
    if (blogPostIds.length === 0) {
      assertMutationCommand(command);
      return operation();
    }
    return executeBlogMutation(
      "blog.post.edit",
      command,
      blogPostIds,
      operation,
    );
  }

  /**
   * The page id a create or a duplicate mints.
   *
   * It is built from the one thing that identifies this request and nothing
   * else: its idempotency key, inside its workspace. Three things follow.
   * Sending the same request twice mints the same id, so a retry can never
   * leave two pages behind. The id is never built from the page's name or its
   * web address, both of which change while a page id never does. And because
   * a fresh request always carries a fresh key, a deleted page's id is never
   * minted again. See ADR-0033.
   */
  async function mintPageId(command: PageMutationCommand): Promise<string> {
    return mintedPageId(
      await sha256CanonicalJson({
        purpose: "foundry.page.id",
        workspaceId: command.workspaceId,
        idempotencyKey: command.idempotencyKey,
      }),
    );
  }

  /** Run one page operation as a new revision of the draft. */
  async function runPageMutation(
    command: PageMutationCommand,
    pageId: string,
    requestIdentity: unknown,
    mutate: (base: SiteDefinition) => SiteDefinition,
  ): Promise<PageMutationResult> {
    const persisted = await persistDefinitionMutationWithReplay({
      command,
      requestIdentity,
      mutate(base) {
        try {
          return mutate(base);
        } catch (error) {
          if (error instanceof PageLifecycleError) {
            throw new ContentPageOperationError(error);
          }
          throw error;
        }
      },
    });
    return Object.freeze({
      revision: persisted.revision,
      pageId,
      replayed: persisted.replayed,
    });
  }

  /** The five things every page operation is identified by, minus the key. */
  function pageRequestIdentity(
    operation: string,
    command: PageMutationCommand,
  ) {
    return {
      operation,
      actorId: command.actorId,
      workspaceId: command.workspaceId,
      schemaVersion: command.schemaVersion,
      baseRevision: command.baseRevision,
    };
  }

  /**
   * Rename one page by editing its two fields.
   *
   * A page's name and its web address are editable fields, so a rename is the
   * same write the editor makes when the owner retypes either one. That is why
   * there is no second set of rules here: `applySiteDefinitionEdits` runs the
   * field's own refusals, and the owner reads the same sentence on both
   * surfaces. See ADR-0033.
   */
  function renamePageDefinition(
    base: SiteDefinition,
    command: RenamePageCommand,
  ): SiteDefinition {
    if (findPageById(base, command.pageId) === undefined) {
      throw new PageLifecycleError("page_not_found", {
        pageId: "That page is not in this draft any more.",
      });
    }
    const titlePath = `${command.pageId}.title`;
    const slugPath = `${command.pageId}.slug`;
    const edited = applySiteDefinitionEdits(
      base,
      [
        { path: titlePath, value: command.title },
        { path: slugPath, value: command.slug },
      ],
      isDefinition,
    );
    if (edited.ok) {
      return edited.definition;
    }
    // Report each refusal against the name the caller used for it, so a
    // dashboard dialog and an MCP tool can both show it beside the right box.
    const fields = Object.create(null) as Record<string, string>;
    for (const [path, message] of Object.entries(edited.errors)) {
      fields[
        path === titlePath ? "title" : path === slugPath ? "slug" : path
      ] = message;
    }
    throw new ContentRevisionValidationError(fields);
  }

  return Object.freeze({
    workspaceId,
    rendererVersion,
    queries: Object.freeze({
      async getCurrent() {
        await store.requireAccess(actorId);
        return store.getCurrent();
      },
      async getRevision(revision: number, bookmark?: string) {
        await store.requireAccess(actorId);
        return store.getRevision(revision, bookmark);
      },
      async getRevisionWithBookmark(revision: number) {
        await store.requireAccess(actorId);
        return store.getRevisionWithBookmark(revision);
      },
      async isRevisionCurrent(revision: ContentRevision) {
        await store.requireAccess(actorId);
        return isContentRevisionRenderableBy(revision, {
          schemaVersion: siteDefinition.schemaVersion,
          rendererVersion,
          productionBase: await resolveProductionBase(),
        });
      },
    }),
    commands: Object.freeze({
      async recordRejectedBlogPostCommand(command: {
        actorId: ContentActorId;
        postId: BlogPostId | null;
        commandType: BlogPostTransitionAudit["commandType"];
        reasonCode: string;
        requestId: string;
      }) {
        if (command.actorId !== actorId) {
          throw new ContentWorkspaceAccessError();
        }
        await store.requireAccess(actorId);
        await store.recordRejectedBlogTransition({
          workspaceId,
          actorId,
          postId: command.postId,
          commandType: command.commandType,
          reasonCode: command.reasonCode,
          requestId: blogAuditRequestId(command.requestId),
          beforeState: null,
          afterState: null,
          occurredAt: now(),
        });
      },
      async create(command: CreateContentWorkspaceCommand) {
        if (command.actorId !== actorId) {
          throw new ContentWorkspaceAccessError();
        }
        if (
          !isValidContentMutationIdempotencyKey(command.idempotencyKey)
        ) {
          throw new ContentRevisionValidationError({
            idempotencyKey: "Use a 16–128 character idempotency key.",
          });
        }
        if (command.workspaceId !== workspaceId) {
          throw new ContentRevisionValidationError({
            workspaceId: "This workspace is not available.",
          });
        }
        await initialize(command.joinedAudit);
        return store.getCurrent();
      },
      async createWithReplay(command: CreateContentWorkspaceCommand) {
        if (command.actorId !== actorId) {
          throw new ContentWorkspaceAccessError();
        }
        if (
          !isValidContentMutationIdempotencyKey(command.idempotencyKey)
        ) {
          throw new ContentRevisionValidationError({
            idempotencyKey: "Use a 16–128 character idempotency key.",
          });
        }
        if (command.workspaceId !== workspaceId) {
          throw new ContentRevisionValidationError({
            workspaceId: "This workspace is not available.",
          });
        }
        const alreadyInitialized = initialization !== undefined;
        const created = await initialize(command.joinedAudit);
        const initial = await store.getRevisionWithBookmark(0);
        if (initial === null) {
          throw new ContentRevisionConfigurationError();
        }
        if (
          alreadyInitialized &&
          command.joinedAudit !== undefined
        ) {
          await store.recordJoinedMcpAudit(command.joinedAudit, {
            resultHash: initial.inputs.contentHash,
            workspaceId: initial.workspaceId,
            revision: initial.revision,
            contentHash: initial.inputs.contentHash,
          });
        }
        return { revision: initial, replayed: alreadyInitialized || !created };
      },
      async save(command: SaveContentRevisionCommand) {
        return (await saveDefinitionMutation(command)).revision;
      },
      async saveWithReplay(command: SaveContentRevisionCommand) {
        return saveDefinitionMutation(command);
      },
      async createPage(command: CreatePageCommand): Promise<PageMutationResult> {
        await store.requireAccess(actorId);
        assertMutationCommand(command);
        const pageId = await mintPageId(command);
        return runPageMutation(
          command,
          pageId,
          {
            ...pageRequestIdentity("create_page", command),
            title: command.title,
            slug: command.slug,
            startingLayout: command.startingLayout,
          },
          (base) =>
            addPageToDefinition(
              base,
              {
                pageId,
                title: command.title,
                slug: command.slug,
                startingLayout: command.startingLayout,
              },
              isDefinition,
              pageComponents,
            ),
        );
      },
      async renamePage(command: RenamePageCommand): Promise<PageMutationResult> {
        await store.requireAccess(actorId);
        assertMutationCommand(command);
        return runPageMutation(
          command,
          command.pageId,
          {
            ...pageRequestIdentity("rename_page", command),
            pageId: command.pageId,
            title: command.title,
            slug: command.slug,
          },
          (base) => renamePageDefinition(base, command),
        );
      },
      async duplicatePage(
        command: DuplicatePageCommand,
      ): Promise<PageMutationResult> {
        await store.requireAccess(actorId);
        assertMutationCommand(command);
        const pageId = await mintPageId(command);
        return runPageMutation(
          command,
          pageId,
          {
            ...pageRequestIdentity("duplicate_page", command),
            pageId: command.pageId,
            title: command.title,
            slug: command.slug,
          },
          (base) =>
            duplicatePageInDefinition(
              base,
              {
                sourcePageId: command.pageId,
                pageId,
                title: command.title,
                slug: command.slug,
              },
              isDefinition,
              pageComponents,
            ),
        );
      },
      async deletePage(command: DeletePageCommand): Promise<PageMutationResult> {
        await store.requireAccess(actorId);
        assertMutationCommand(command);
        return runPageMutation(
          command,
          command.pageId,
          {
            ...pageRequestIdentity("delete_page", command),
            pageId: command.pageId,
          },
          (base) => removePageFromDefinition(base, command.pageId, isDefinition),
        );
      },
      async createBlogPost(command: CreateBlogPostCommand) {
        return executeBlogMutation(
          "blog.post.create",
          command,
          [command.post.id],
          () =>
          persistDefinitionMutation({
            command,
            requestIdentity: { operation: "create_blog_post", ...command },
            mutate: (definition) =>
              createBlogPostDefinition(
                definition,
                command.siteId,
                command.post,
                isDefinition,
              ),
            blogTransitions: [
              {
                commandType: "blog.post.create",
                postId: command.post.id,
              },
            ],
          }),
        );
      },
      async editBlogPost(command: EditBlogPostCommand) {
        return executeBlogMutation(
          "blog.post.edit",
          command,
          [command.postId],
          () =>
          persistDefinitionMutation({
            command,
            requestIdentity: { operation: "edit_blog_post", ...command },
            mutate: (definition) =>
              editBlogPostDefinition(
                definition,
                command.siteId,
                command.postId,
                command.post,
                isDefinition,
              ),
            blogTransitions: [
              {
                commandType: "blog.post.edit",
                postId: command.postId,
              },
            ],
          }),
        );
      },
      async unpublishBlogPost(command: UnpublishBlogPostCommand) {
        return executeBlogMutation(
          "blog.post.unpublish",
          command,
          [command.postId],
          () =>
            persistDefinitionMutation({
              command,
              requestIdentity: {
                operation: "unpublish_blog_post",
                ...command,
              },
              mutate: async (definition, observedBlogAggregates) => {
                const aggregate =
                  observedBlogAggregates.get(command.postId) ?? null;
                if (
                  aggregate?.liveRevision === null ||
                  aggregate === null
                ) {
                  throw new BlogPostSchemaError("post_not_live");
                }
                return unpublishBlogPostDefinition(
                  definition,
                  command.siteId,
                  command.postId,
                  isDefinition,
                );
              },
              blogTransitions: [
                {
                  commandType: "blog.post.unpublish",
                  postId: command.postId,
                },
              ],
            }),
        );
      },
      async republishBlogPost(command: RepublishBlogPostCommand) {
        return executeBlogMutation(
          "blog.post.republish",
          command,
          [command.postId],
          () =>
            persistDefinitionMutation({
              command,
              requestIdentity: {
                operation: "republish_blog_post",
                ...command,
              },
              mutate: async (definition, observedBlogAggregates) => {
                const aggregate =
                  observedBlogAggregates.get(command.postId) ?? null;
                if (
                  aggregate === null ||
                  aggregate.liveRevision !== null ||
                  (
                    aggregate.lastVerifiedVisibility !== "unpublished" &&
                    aggregate.lastVerifiedVisibility !== "absent"
                  )
                ) {
                  throw new ContentRevisionValidationError({
                    blog: "post_not_unpublished",
                  });
                }
                return republishBlogPostDefinition(
                  definition,
                  command.siteId,
                  command.postId,
                  isDefinition,
                );
              },
              blogTransitions: [
                {
                  commandType: "blog.post.republish",
                  postId: command.postId,
                },
              ],
            }),
        );
      },
      async saveMediaOccurrence(command: SaveContentMediaOccurrenceCommand) {
        if (command.actorId !== actorId) {
          throw new ContentWorkspaceAccessError();
        }
        if (!/^[A-Za-z0-9._:-]{16,128}$/.test(command.idempotencyKey)) {
          throw new ContentRevisionValidationError({
            idempotencyKey: "Use a 16–128 character idempotency key.",
          });
        }
        if (command.workspaceId !== workspaceId) {
          throw new ContentRevisionValidationError({
            workspaceId: "This workspace is not available.",
          });
        }
        await store.requireAccess(actorId);
        const currentProductionBase = await resolveProductionBase();
        const requestHash = await sha256CanonicalJson(command);
        const replay = await store.replay(
          command.idempotencyKey,
          requestHash,
        );
        if (replay !== null) {
          if (
            !isContentRevisionRenderableBy(replay, {
              schemaVersion: siteDefinition.schemaVersion,
              rendererVersion,
              productionBase: currentProductionBase,
            })
          ) {
            throw new ContentRevisionStaleError(replay.revision);
          }
          return replay;
        }
        if (command.schemaVersion !== siteDefinition.schemaVersion) {
          throw new ContentRevisionValidationError({
            schemaVersion:
              `Use Site Definition schema ${siteDefinition.schemaVersion}.`,
          });
        }
        const base = await store.getRevision(command.baseRevision);
        if (base === null) {
          const current = await store.getCurrent();
          throw new ContentRevisionConflictError(current.revision);
        }
        if (
          !isContentRevisionRenderableBy(base, {
            schemaVersion: siteDefinition.schemaVersion,
            rendererVersion,
            productionBase: currentProductionBase,
          })
        ) {
          throw new ContentRevisionStaleError();
        }
        const definition = bindSiteMediaOccurrence(
          base.definition,
          command.occurrence,
        );
        const nextRevision: ContentRevision = {
          workspaceId,
          revision: command.baseRevision + 1,
          definition,
          inputs: {
            contentHash: await sha256CanonicalJson(definition),
            schemaVersion: definition.schemaVersion,
            rendererVersion,
            productionBase: base.inputs.productionBase,
          },
          createdAt: now(),
          createdBy: command.actorId,
        };
        const blogArtifacts = await createBlogPostArtifactFingerprints({
          definition,
          inputs: {
            schemaVersion: definition.schemaVersion,
            rendererVersion,
          },
        });
        return (
          await store.persist({
          baseRevision: command.baseRevision,
          idempotencyKey: command.idempotencyKey,
          requestHash,
          revision: nextRevision,
          blogArtifacts,
          mediaOccurrence: {
            occurrenceId: command.occurrence.occurrenceId,
            revision: command.occurrence.revision,
            assetId: command.occurrence.asset.assetId,
            crop: command.occurrence.crop,
          },
          })
        ).revision;
      },
      async addCollaborator(collaboratorActorId: ContentActorId) {
        await store.requireAccess(actorId);
        await store.addCollaborator(actorId, collaboratorActorId);
      },
    }),
  });
}

export type ContentRevisionApplication = ReturnType<
  typeof createContentRevisionApplication
>;
