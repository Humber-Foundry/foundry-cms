import { headers } from "next/headers";
import { notFound } from "next/navigation";

import {
  AccessDeniedError,
  type ContentRevision,
  type MediaAsset,
  ContentRevisionConfigurationError,
  ContentWorkspaceAccessError,
  createContentActorId,
  createBlogPostArtifactFingerprints,
  createContentWorkspaceId,
} from "@foundry/application";

import { DashboardShell } from "@/components/dashboard-shell";
import { InvitationActivation } from "@/components/invitation-activation";
import { mergeMediaOccurrenceState } from "@/components/media-manager-state";
import { AccessIdentityError } from "@/src/access-identity";
import {
  loadHumanAccessRequestContext,
} from "@/src/human-access-runtime";
import { HumanAccessConfigurationError } from "@/src/human-access-configuration";
import { createHumanMutationToken } from "@/src/human-mutation-runtime";
import {
  contentWorkspaceIdForActor,
  latestContentWorkspaceIdForActor,
  loadContentRevisionApplication,
  requireExistingContentWorkspaceAccess,
} from "@/src/content-revision-runtime";
import { revisionPreviewGatewayUrl } from "@/src/content-revision-links";
import { referenceSiteApplication } from "@/src/reference-installation";
import { loadPublicFormOperationsDashboard } from "@/src/public-form-delivery-health-runtime";
import { durableSchemaRecoveryEdits } from "@/src/content-schema-recovery";
import type { StaleRecoveryEdit } from "@/src/content-editor-recovery";

import "./dashboard.css";
import "../public.css";
import "@puckeditor/core/puck.css";

export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{
    workspace?: string | string[];
    recovery?: string | string[];
    recoverFrom?: string | string[];
  }>;
}) {
  let access;
  try {
    access = await loadHumanAccessRequestContext(await headers());
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

  const definition =
    await referenceSiteApplication.queries.getPublishedSite();
  if (access.state === "invited") {
    return (
      <InvitationActivation
        csrfToken={await createHumanMutationToken(access.identity)}
        email={access.identity.email}
      />
    );
  }
  const actorId = createContentActorId(access.membership.id);
  const requested = await searchParams;
  let staleRecovery:
    | Readonly<{ id: string; sourceWorkspaceId: string }>
    | undefined;
  if (
    typeof requested.recovery === "string" &&
    typeof requested.recoverFrom === "string"
  ) {
    try {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
          requested.recovery,
        )
      ) {
        notFound();
      }
      const sourceWorkspaceId = createContentWorkspaceId(
        requested.recoverFrom,
      );
      await requireExistingContentWorkspaceAccess(
        sourceWorkspaceId,
        actorId,
      );
      staleRecovery = {
        id: requested.recovery,
        sourceWorkspaceId,
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
  const members =
    access.membership.role === "owner"
      ? await access.application.queries.listMembers({
          actor: access.identity,
        })
      : [];
  const mutationToken = await createHumanMutationToken(access.identity);
  const formOperations = await loadPublicFormOperationsDashboard(access);
  let workspaceId;
  const requestedWorkspace =
    typeof requested.workspace === "string" ? requested.workspace : undefined;
  const hasRequestedWorkspace = requestedWorkspace !== undefined;
  try {
    workspaceId =
      requestedWorkspace === undefined
        ? (await latestContentWorkspaceIdForActor(actorId)) ??
          (await contentWorkspaceIdForActor(actorId))
        : createContentWorkspaceId(requestedWorkspace);
  } catch {
    notFound();
  }
  let contentRevision: ContentRevision | undefined;
  let initialContentStale: boolean | undefined;
  let initialPreviewUrl: string | undefined;
  let durableSchemaRecovery: ReadonlyArray<StaleRecoveryEdit> | undefined;
  try {
    await requireExistingContentWorkspaceAccess(workspaceId, actorId);
    const contentApplication = await loadContentRevisionApplication(
      workspaceId,
      actorId,
    );
    contentRevision = await contentApplication.queries.getCurrent();
    if (
      contentRevision.inputs.schemaVersion !== definition.schemaVersion
    ) {
      const baseRevision =
        await contentApplication.queries.getRevision(0);
      if (baseRevision === null) {
        throw new ContentRevisionConfigurationError();
      }
      durableSchemaRecovery = durableSchemaRecoveryEdits(
        baseRevision.definition,
        contentRevision.definition,
      );
    }
    initialContentStale =
      !(await contentApplication.queries.isRevisionCurrent(contentRevision));
    initialPreviewUrl = revisionPreviewGatewayUrl(
      contentRevision.workspaceId,
      contentRevision.revision,
    );
  } catch (error) {
    if (
      error instanceof ContentWorkspaceAccessError &&
      !hasRequestedWorkspace
    ) {
      contentRevision = undefined;
    } else if (
      error instanceof ContentWorkspaceAccessError ||
      error instanceof ContentRevisionConfigurationError
    ) {
      notFound();
    } else {
      throw error;
    }
  }
  const mediaAssets: ReadonlyArray<MediaAsset> = [];
  const mediaOccurrences = mergeMediaOccurrenceState(
    [],
    contentRevision?.definition.home.media ?? [],
  );

  return (
    <DashboardShell
      definition={definition}
      currentMembership={access.membership}
      members={members}
      mutationToken={mutationToken}
      contentRevision={contentRevision}
      contentMutationToken={mutationToken}
      initialPreviewUrl={initialPreviewUrl}
      initialContentStale={initialContentStale}
      staleRecovery={staleRecovery}
      durableSchemaRecovery={durableSchemaRecovery}
      formDeliveryHealth={formOperations.health}
      failedFormDeliveries={formOperations.failedDeliveries}
      suspectedSpam={formOperations.suspectedSpam}
      mediaAssets={mediaAssets}
      mediaOccurrences={mediaOccurrences}
      mediaWorkspaceId={workspaceId}
      campaignPostArtifacts={
        contentRevision === undefined
          ? []
          : await createBlogPostArtifactFingerprints({
              definition: contentRevision.definition,
              inputs: {
                ...contentRevision.inputs,
                schemaVersion: contentRevision.definition.schemaVersion,
              },
            })
      }
    />
  );
}
