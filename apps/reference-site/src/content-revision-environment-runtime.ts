import {
  ContentRevisionConfigurationError,
  createContentRevisionApplication,
  type ContentActorId,
  type ContentWorkspaceId,
} from "@humber-foundry/application";
import {
  referenceSiteDefinition,
  type SiteDefinition,
} from "@humber-foundry/site-definition";

import { upgradeSiteDefinitionForCurrentSchema } from "./content-schema-recovery";
import {
  createD1ContentRevisionStore,
  hydrateManagedBlogPosts,
  type D1ContentRevisionInitializationExtension,
} from "./d1-content-revision-store";
import type { HumanAccessEnvironment } from "./human-access-configuration";

function releaseInputs(environment: HumanAccessEnvironment) {
  const commit =
    process.env.FOUNDRY_RELEASE_COMMIT_SHA ??
    environment.FOUNDRY_PRODUCTION_BASE;
  const rendererVersion =
    commit ??
    environment.CF_VERSION_METADATA?.id ??
    environment.FOUNDRY_RENDERER_VERSION;
  if (
    commit === undefined ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit) ||
    rendererVersion === undefined ||
    rendererVersion.trim() === ""
  ) {
    throw new ContentRevisionConfigurationError();
  }
  return { commit, rendererVersion };
}

function application(input: {
  environment: HumanAccessEnvironment;
  workspaceId: ContentWorkspaceId;
  actorId: ContentActorId;
  initialDefinition: SiteDefinition;
  initialCreatedBy?: ContentActorId;
  initializationExtension?: D1ContentRevisionInitializationExtension;
}) {
  if (input.environment.FOUNDRY_DB === undefined) {
    throw new ContentRevisionConfigurationError();
  }
  const { commit, rendererVersion } = releaseInputs(input.environment);
  return createContentRevisionApplication({
    siteDefinition: referenceSiteDefinition,
    initialDefinition: input.initialDefinition,
    ...(input.initialCreatedBy === undefined
      ? {}
      : { initialCreatedBy: input.initialCreatedBy }),
    store: createD1ContentRevisionStore(
      input.environment.FOUNDRY_DB,
      referenceSiteDefinition.site.id,
      input.workspaceId,
      input.initializationExtension,
    ),
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    rendererVersion,
    productionBase: (contentHash) =>
      `git:${commit}@content:${contentHash}`,
  });
}

export async function createContentRevisionApplicationForEnvironment(
  environment: HumanAccessEnvironment,
  workspaceId: ContentWorkspaceId,
  actorId: ContentActorId,
) {
  if (environment.FOUNDRY_DB === undefined) {
    throw new ContentRevisionConfigurationError();
  }
  return application({
    environment,
    workspaceId,
    actorId,
    initialDefinition: await hydrateManagedBlogPosts(
      environment.FOUNDRY_DB,
      referenceSiteDefinition,
    ),
  });
}

export function createRestoredContentRevisionApplicationForEnvironment(
  environment: HumanAccessEnvironment,
  workspaceId: ContentWorkspaceId,
  actorId: ContentActorId,
  definition: SiteDefinition,
  initializationExtension?: D1ContentRevisionInitializationExtension,
) {
  let current: SiteDefinition;
  try {
    current = upgradeSiteDefinitionForCurrentSchema(definition);
  } catch {
    throw new ContentRevisionConfigurationError();
  }
  if (
    current.site.id !== referenceSiteDefinition.site.id ||
    current.schemaVersion !== referenceSiteDefinition.schemaVersion ||
    current.definitionVersion !== referenceSiteDefinition.definitionVersion
  ) {
    throw new ContentRevisionConfigurationError();
  }
  return application({
    environment,
    workspaceId,
    actorId,
    initialDefinition: current,
    initialCreatedBy: actorId,
    initializationExtension,
  });
}
