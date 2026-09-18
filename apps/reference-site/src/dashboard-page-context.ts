import "server-only";

import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import {
  AccessDeniedError,
  type ContentActorId,
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
  latestContentWorkspaceIdForActor,
  loadContentRevisionApplication,
  openDefaultContentWorkspace,
  openDefaultWorkspaceIdempotencyKey,
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
  /** The workspace the owner is editing. It always exists. */
  workspaceId: ContentWorkspaceId;
  /** The workspace's current revision. A workspace always has one. */
  contentRevision: ContentRevision;
  previewUrl: string;
  contentStale: boolean;
  /**
   * Set when the draft was written against an older site schema. The owner has
   * to start a fresh workspace; these edits are what can be carried across.
   */
  schemaRecovery?: ReadonlyArray<StaleRecoveryEdit>;
  /** The `/dash` URL that keeps the current workspace selected. */
  activeWorkspaceUrl: string;
}>;

/**
 * Pick the workspace an editing route should open, and make sure it exists.
 *
 * A workspace id in `?workspace=` is only used when the person can still open
 * it. A stale or shared link therefore falls back to their own workspace
 * instead of a 404. When they have no workspace at all, this creates their
 * default one, so no destination has to ask a site owner to start a draft.
 */
async function resolveDashboardWorkspaceId(
  actorId: ContentActorId,
  requestedWorkspace?: string,
): Promise<ContentWorkspaceId> {
  // A malformed id is a bad link, not a failure worth reporting. Validating it
  // outside the access check keeps a real fault inside that check visible.
  let requested: ContentWorkspaceId | undefined;
  if (requestedWorkspace !== undefined) {
    try {
      requested = createContentWorkspaceId(requestedWorkspace);
    } catch {
      requested = undefined;
    }
  }

  if (requested !== undefined) {
    try {
      await requireExistingContentWorkspaceAccess(requested, actorId);
      return requested;
    } catch (error) {
      if (!(error instanceof ContentWorkspaceAccessError)) {
        throw error;
      }
    }
  }

  const latest = await latestContentWorkspaceIdForActor(actorId);
  if (latest !== null) {
    return latest;
  }
  return (
    await openDefaultContentWorkspace(
      actorId,
      openDefaultWorkspaceIdempotencyKey,
    )
  ).workspaceId;
}

/** The preserved draft a recovery screen offers to replace. */
export function preservedRevisionOf(contentRevision: ContentRevision) {
  return {
    workspaceId: contentRevision.workspaceId,
    revision: contentRevision.revision,
    schemaVersion: contentRevision.inputs.schemaVersion,
  };
}

/**
 * Resolve the workspace and its current revision for an editing route.
 *
 * `requestedWorkspace` comes from the `?workspace=` search parameter. The
 * returned workspace always exists and always holds a revision, so a
 * destination never has to render a "start a draft" step.
 */
export async function loadDashboardWorkspace(
  requestedWorkspace?: string,
  routePath = "/dash",
): Promise<DashboardWorkspace> {
  const access = await requireAuthorizedDashboardAccess();
  const definition = await loadPublishedDefinition();
  const actorId = createContentActorId(access.membership.id);

  try {
    const workspaceId = await resolveDashboardWorkspaceId(
      actorId,
      requestedWorkspace,
    );
    const activeWorkspaceUrl = `${routePath}?workspace=${encodeURIComponent(
      workspaceId,
    )}`;

    // The URL asked for a workspace this person cannot open. Send them to the
    // one they did get, so the address bar and every sidebar link stop
    // carrying the dead id.
    if (requestedWorkspace !== undefined && requestedWorkspace !== workspaceId) {
      redirect(activeWorkspaceUrl);
    }

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
    // The workspace existed a moment ago, so reaching either of these means
    // the installation is broken rather than that the owner has no draft.
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
 *
 * A pair that cannot be honoured is dropped rather than reported as a missing
 * page. Recovery edits are held in the person's own browser, so a stale or
 * shared link carries a pointer to edits this browser does not have; the
 * destination still has a workspace to open.
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

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      requested.recovery,
    )
  ) {
    return { workspace };
  }

  const access = await requireAuthorizedDashboardAccess();
  const actorId = createContentActorId(access.membership.id);
  try {
    const sourceWorkspaceId = createContentWorkspaceId(requested.recoverFrom);
    await requireExistingContentWorkspaceAccess(sourceWorkspaceId, actorId);
    return {
      workspace,
      staleRecovery: { id: requested.recovery, sourceWorkspaceId },
    };
  } catch (error) {
    if (
      error instanceof ContentWorkspaceAccessError ||
      error instanceof TypeError
    ) {
      return { workspace };
    }
    if (error instanceof ContentRevisionConfigurationError) {
      notFound();
    }
    throw error;
  }
}
