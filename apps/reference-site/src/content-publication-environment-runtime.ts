import {
  confirmVerifiedArchiveWithdrawals,
} from "./d1-blog-post-operations-store";
import {
  ContentRevisionConfigurationError,
  createContentPublicationApplication,
  parseProductionBase,
  type ContentApprovalId,
  type ContentActorId,
  type ContentPublication,
  type ContentPublicationDraftRestorer,
  type ContentPublicationRevisionRepository,
  type ContentPublishedRevisionReader,
  type ContentPublisher,
  type ContentWorkspaceId,
} from "@humber-foundry/application";
import { createContentRevisionApplicationForEnvironment } from "./content-revision-environment-runtime";
import { createD1ContentPublicationStore } from "./d1-content-publication-store";
import {
  findContentRevision,
  findVerifiedPublicationOrder,
  listContentRevisionContributors,
  reconcileVerifiedBlogPostPublication,
} from "./d1-content-revision-store";
import {
  createGitHubContentPublisher,
  readGitHubContentPublisherConfiguration,
} from "./github-content-publisher";
import type { HumanAccessEnvironment } from "./human-access-configuration";
import { isInstalledSiteDefinition } from "../foundry/site-definition";

export function createD1ContentPublicationApplication(input: {
  database: NonNullable<HumanAccessEnvironment["FOUNDRY_DB"]>;
  revisions: ContentPublicationRevisionRepository;
  publisher: ContentPublisher;
  publishedRevisions?: ContentPublishedRevisionReader;
  draftRestorer?: ContentPublicationDraftRestorer;
  restoreSourcePublication?: ContentPublication;
}) {
  return createContentPublicationApplication({
    isDefinition: isInstalledSiteDefinition,
    store: createD1ContentPublicationStore(input.database),
    revisions: input.revisions,
    publisher: input.publisher,
    ...(input.publishedRevisions === undefined
      ? {}
      : { publishedRevisions: input.publishedRevisions }),
    ...(input.draftRestorer === undefined
      ? {}
      : { draftRestorer: input.draftRestorer }),
    ...(input.restoreSourcePublication === undefined
      ? {}
      : { restoreSourcePublication: input.restoreSourcePublication }),
    onVerifiedLive: async (publication, revision) => {
      const siteId = revision.definition.site.id;
      await reconcileVerifiedBlogPostPublication(
        input.database,
        siteId,
        revision.definition,
        await findVerifiedPublicationOrder(
          input.database,
          publication.id,
        ),
        publication.requestedAt,
      );
      await confirmVerifiedArchiveWithdrawals(
        input.database,
        siteId,
        publication.id,
        revision.definition,
        publication.updatedAt,
      );
    },
  });
}

export async function validateContentApprovalProductionAuthority(
  environment: HumanAccessEnvironment & {
    FOUNDRY_DB: NonNullable<HumanAccessEnvironment["FOUNDRY_DB"]>;
  },
  approvalId: ContentApprovalId,
  ownedPublicationIdempotencyKey?: string,
) {
  const store = createD1ContentPublicationStore(environment.FOUNDRY_DB);
  const approval = await store.findApproval(approvalId);
  if (approval === null) {
    return false;
  }
  if (ownedPublicationIdempotencyKey !== undefined) {
    const ownedPublication = await store.findPublicationByIdempotency({
      workspaceId: approval.workspaceId,
      idempotencyKey: ownedPublicationIdempotencyKey,
    });
    if (
      ownedPublication !== null &&
      await store.hasScheduledPublicationOwnership({
        publicationId: ownedPublication.id,
      }) &&
      ownedPublication.approvalId === approval.id &&
      ownedPublication.fingerprint === approval.fingerprint.value &&
      (
        ownedPublication.status === "requested" ||
        ownedPublication.status === "committed" ||
        ownedPublication.status === "building" ||
        ownedPublication.status === "deployed" ||
        ownedPublication.status === "unknown" ||
        ownedPublication.status === "verified-live" ||
        (
          ownedPublication.status === "failed" &&
          approval.invalidatedAt === null
        )
      )
    ) {
      return true;
    }
  }
  if (approval.invalidatedAt !== null) {
    return false;
  }
  const base = parseProductionBase(approval.fingerprint.productionBase);
  const publisher = createGitHubContentPublisher({
    configuration:
      readGitHubContentPublisherConfiguration(environment),
  });
  const [head, releaseIsLive] = await Promise.all([
    publisher.getProductionHead(),
    publisher.isReleaseLive({
      commitSha: base.commitSha,
      contentHash: base.contentHash,
      schemaVersion: approval.fingerprint.schemaVersion,
    }),
  ]);
  if (head === base.commitSha && releaseIsLive) {
    return true;
  }
  await store.invalidateApproval({
    approvalId,
    invalidatedAt: new Date().toISOString(),
    reason: "production_changed",
  });
  return false;
}

export async function createContentPublicationApplicationForEnvironment(
  environment: HumanAccessEnvironment,
  workspaceId: ContentWorkspaceId,
  actorId: ContentActorId,
) {
  if (environment.FOUNDRY_DB === undefined) {
    throw new ContentRevisionConfigurationError();
  }
  const database = environment.FOUNDRY_DB;
  const revisionApplication =
    await createContentRevisionApplicationForEnvironment(
      environment,
      workspaceId,
      actorId,
    );
  return createD1ContentPublicationApplication({
    database,
    revisions: {
      getRevision: (targetWorkspaceId, revision) =>
        findContentRevision(database, targetWorkspaceId, revision),
      getCurrent: () => revisionApplication.queries.getCurrent(),
      isCurrent: (revision) =>
        revisionApplication.queries.isRevisionCurrent(revision),
      listContributors: (targetWorkspaceId, revision) =>
        listContentRevisionContributors(
          database,
          targetWorkspaceId,
          revision,
        ),
    },
    publisher: createGitHubContentPublisher({
      configuration:
        readGitHubContentPublisherConfiguration(environment),
    }),
  });
}
