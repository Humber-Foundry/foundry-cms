import "server-only";

import {
  ContentRevisionConfigurationError,
  createContentPublicationApplication,
  createInMemoryContentPublicationStore,
  type ContentActorId,
  type ContentPublicationStore,
  type ContentPublisher,
  type ContentWorkspaceId,
} from "@foundry/application";

import { loadContentRevisionApplication } from "./content-revision-runtime";
import { createD1ContentPublicationStore } from "./d1-content-publication-store";
import { listContentRevisionContributors } from "./d1-content-revision-store";
import {
  createGitHubContentPublisher,
  readGitHubContentPublisherConfiguration,
} from "./github-content-publisher";
import { loadHumanAccessEnvironment } from "./human-access-environment";

const localRuntime = globalThis as typeof globalThis & {
  __foundryContentPublicationStore?: ReturnType<
    typeof createInMemoryContentPublicationStore
  >;
};
localRuntime.__foundryContentPublicationStore ??=
  createInMemoryContentPublicationStore();

const localPublisher: ContentPublisher = {
  async getChannelConfigurationHash() {
    return "local-publication-disabled";
  },
  async getProductionHead() {
    throw new ContentRevisionConfigurationError();
  },
  async isReleaseLive() {
    return false;
  },
  async createCommit() {
    return { state: "blocked", detail: "local_publication_disabled" };
  },
  async reconcileCommit() {
    return { state: "not-found" };
  },
  async retryReference() {
    throw new ContentRevisionConfigurationError();
  },
  async getDeploymentStatus() {
    return "unknown";
  },
  async retryDeployment() {
    throw new ContentRevisionConfigurationError();
  },
};

function publicationQueries(store: ContentPublicationStore) {
  return Object.freeze({
    getLatest: store.findLatestPublication,
    get: store.findPublication,
  });
}

export async function loadContentPublicationQueries() {
  if (process.env.NODE_ENV === "development") {
    return publicationQueries(
      localRuntime.__foundryContentPublicationStore!,
    );
  }
  const environment = await loadHumanAccessEnvironment();
  if (environment.FOUNDRY_DB === undefined) {
    throw new ContentRevisionConfigurationError();
  }
  return publicationQueries(
    createD1ContentPublicationStore(environment.FOUNDRY_DB),
  );
}

export async function loadContentPublicationApplication(
  workspaceId: ContentWorkspaceId,
  actorId: ContentActorId,
) {
  const revisionApplication = await loadContentRevisionApplication(
    workspaceId,
    actorId,
  );
  if (process.env.NODE_ENV === "development") {
    return createContentPublicationApplication({
      store: localRuntime.__foundryContentPublicationStore!,
      revisions: {
        getRevision: (_workspaceId, revision) =>
          revisionApplication.queries.getRevision(revision),
        getCurrent: () => revisionApplication.queries.getCurrent(),
        isCurrent: (revision) =>
          revisionApplication.queries.isRevisionCurrent(revision),
        async listContributors(_workspaceId, revision) {
          const selected =
            await revisionApplication.queries.getRevision(revision);
          return selected === null ||
            selected.createdBy === "system:published-base"
            ? []
            : [selected.createdBy];
        },
      },
      publisher: localPublisher,
    });
  }
  const environment = await loadHumanAccessEnvironment();
  if (environment.FOUNDRY_DB === undefined) {
    throw new ContentRevisionConfigurationError();
  }
  return createContentPublicationApplication({
    store: createD1ContentPublicationStore(environment.FOUNDRY_DB),
    revisions: {
      getRevision: (_workspaceId, revision) =>
        revisionApplication.queries.getRevision(revision),
      getCurrent: () => revisionApplication.queries.getCurrent(),
      isCurrent: (revision) =>
        revisionApplication.queries.isRevisionCurrent(revision),
      listContributors: (targetWorkspaceId, revision) =>
        listContentRevisionContributors(
          environment.FOUNDRY_DB!,
          targetWorkspaceId,
          revision,
        ),
    },
    publisher: createGitHubContentPublisher({
      configuration: readGitHubContentPublisherConfiguration(environment),
    }),
  });
}
