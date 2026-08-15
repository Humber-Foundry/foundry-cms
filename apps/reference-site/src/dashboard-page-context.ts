import "server-only";

import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";

import {
  AccessDeniedError,
  type ContentRevision,
  type ContentWorkspaceId,
  ContentRevisionConfigurationError,
  ContentWorkspaceAccessError,
  createContentActorId,
  createContentWorkspaceId,
} from "@humber-foundry/application";
import type { SiteDefinition } from "@humber-foundry/site-definition";

import { AccessIdentityError } from "@/src/access-identity";
import { HumanAccessConfigurationError } from "@/src/human-access-configuration";
import { loadHumanAccessRequestContext } from "@/src/human-access-runtime";
import { createHumanMutationToken } from "@/src/human-mutation-runtime";
import {
  contentWorkspaceIdForActor,
  latestContentWorkspaceIdForActor,
  loadContentRevisionApplication,
  requireExistingContentWorkspaceAccess,
} from "@/src/content-revision-runtime";
import { revisionPreviewGatewayUrl } from "@/src/content-revision-links";
import { installedSite } from "@/foundry/site-definition.server";
import { durableSchemaRecoveryEdits } from "@/src/content-schema-recovery";
import type { StaleRecoveryEdit } from "@/src/content-editor-recovery";

/**
 * Every `/dash` route needs the same three things before it can render: who is
 * asking, what the published site says, and a token for mutations. Loading them
 * once per request keeps the route files short and stops each new destination
 * from repeating the access-error handling.
 */
export const loadDashboardAccess = cache(async () => {
  try {
    return await loadHumanAccessRequestContext(await headers());
  } catch (error) {
    if (
      error instanceof AccessIdentityError ||
      error instanceof AccessDeniedError ||
      error instanceof HumanAccessConfigurationError
    ) {
      notFound();
    }
    throw error;
  }
});

/**
 * The access context for a route that only signed-in members may open. Routes
 * call this when an invited-but-not-yet-active member has already been handled
 * by the dashboard layout.
 */
export const requireAuthorizedDashboardAccess = cache(async () => {
  const access = await loadDashboardAccess();
  if (access.state !== "authorized") {
    notFound();
  }
  return access;
});

export const loadPublishedDefinition = cache(
  async (): Promise<SiteDefinition> =>
    installedSite.application.queries.getPublishedSite(),
);

export const loadMutationToken = cache(async (): Promise<string> => {
  const access = await requireAuthorizedDashboardAccess();
  return createHumanMutationToken(access.identity);
});

export type DashboardWorkspace = Readonly<{
  /** The workspace the owner is editing, whether or not it holds a revision. */
  workspaceId: ContentWorkspaceId;
  /** Absent until the owner starts a draft workspace. */
  contentRevision?: ContentRevision;
  previewUrl?: string;
  contentStale?: boolean;
  /**
   * Set when the draft was written against an older site schema. The owner has
   * to start a fresh workspace; these edits are what can be carried across.
   */
  schemaRecovery?: ReadonlyArray<StaleRecoveryEdit>;
  /** The `/dash` URL that keeps the current workspace selected. */
  activeWorkspaceUrl: string;
}>;

/**
 * Resolve the workspace and its current revision for an editing route.
 *
 * `requestedWorkspace` comes from the `?workspace=` search parameter. When it
 * is absent the owner gets their most recent workspace, and a missing workspace
 * is reported as "no draft yet" rather than a 404 — that is the state the
 * "Start a draft" call to action exists for.
 */
export async function loadDashboardWorkspace(
  requestedWorkspace?: string,
  routePath = "/dash",
): Promise<DashboardWorkspace> {
  const access = await requireAuthorizedDashboardAccess();
  const definition = await loadPublishedDefinition();
  const actorId = createContentActorId(access.membership.id);
  const hasRequestedWorkspace = requestedWorkspace !== undefined;

  let workspaceId: ContentWorkspaceId;
  try {
    workspaceId =
      requestedWorkspace === undefined
        ? ((await latestContentWorkspaceIdForActor(actorId)) ??
          (await contentWorkspaceIdForActor(actorId)))
        : createContentWorkspaceId(requestedWorkspace);
  } catch {
    notFound();
  }

  const activeWorkspaceUrl = `${routePath}?workspace=${encodeURIComponent(
    workspaceId,
  )}`;

  try {
    await requireExistingContentWorkspaceAccess(workspaceId, actorId);
    const contentApplication = await loadContentRevisionApplication(
      workspaceId,
      actorId,
    );
    const contentRevision = await contentApplication.queries.getCurrent();

    let schemaRecovery: ReadonlyArray<StaleRecoveryEdit> | undefined;
    if (contentRevision.inputs.schemaVersion !== definition.schemaVersion) {
      const baseRevision = await contentApplication.queries.getRevision(0);
      if (baseRevision === null) {
        throw new ContentRevisionConfigurationError();
      }
      schemaRecovery = durableSchemaRecoveryEdits(
        baseRevision.definition,
        contentRevision.definition,
      );
    }

    return {
      workspaceId,
      contentRevision,
      previewUrl: revisionPreviewGatewayUrl(
        contentRevision.workspaceId,
        contentRevision.revision,
      ),
      contentStale: !(await contentApplication.queries.isRevisionCurrent(
        contentRevision,
      )),
      schemaRecovery,
      activeWorkspaceUrl,
    };
  } catch (error) {
    if (
      error instanceof ContentWorkspaceAccessError &&
      !hasRequestedWorkspace
    ) {
      return { workspaceId, activeWorkspaceUrl };
    }
    if (
      error instanceof ContentWorkspaceAccessError ||
      error instanceof ContentRevisionConfigurationError
    ) {
      notFound();
    }
    throw error;
  }
}

/**
 * Read `?workspace=` and `?recovery=`/`?recoverFrom=` from a route's search
 * parameters. The recovery pair is only honoured when both are present and the
 * member can still open the workspace the edits came from.
 */
export async function readWorkspaceSearchParams(
  searchParams: Promise<Record<string, string | string[] | undefined>>,
): Promise<
  Readonly<{
    workspace?: string;
    staleRecovery?: Readonly<{ id: string; sourceWorkspaceId: string }>;
  }>
> {
  const requested = await searchParams;
  const workspace =
    typeof requested.workspace === "string" ? requested.workspace : undefined;

  if (
    typeof requested.recovery !== "string" ||
    typeof requested.recoverFrom !== "string"
  ) {
    return { workspace };
  }

  const access = await requireAuthorizedDashboardAccess();
  const actorId = createContentActorId(access.membership.id);
  try {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        requested.recovery,
      )
    ) {
      notFound();
    }
    const sourceWorkspaceId = createContentWorkspaceId(requested.recoverFrom);
    await requireExistingContentWorkspaceAccess(sourceWorkspaceId, actorId);
    return {
      workspace,
      staleRecovery: { id: requested.recovery, sourceWorkspaceId },
    };
  } catch (error) {
    if (
      error instanceof ContentWorkspaceAccessError ||
      error instanceof ContentRevisionConfigurationError ||
      error instanceof TypeError
    ) {
      notFound();
    }
    throw error;
  }
}
