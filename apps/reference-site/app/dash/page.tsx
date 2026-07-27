import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import {
  AccessDeniedError,
  ContentRevisionConfigurationError,
  ContentWorkspaceAccessError,
  createContentActorId,
  createContentWorkspaceId,
} from "@foundry/application";

import { DashboardShell } from "@/components/dashboard-shell";
import { InvitationActivation } from "@/components/invitation-activation";
import { AccessIdentityError } from "@/src/access-identity";
import {
  loadHumanAccessRequestContext,
} from "@/src/human-access-runtime";
import { HumanAccessConfigurationError } from "@/src/human-access-configuration";
import { createHumanMutationToken } from "@/src/human-mutation-runtime";
import {
  contentWorkspaceIdForActor,
  loadContentRevisionApplication,
  requireExistingContentWorkspaceAccess,
} from "@/src/content-revision-runtime";
import { revisionPreviewGatewayUrl } from "@/src/content-revision-links";
import { referenceSiteApplication } from "@/src/reference-installation";

import "./dashboard.css";

export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{
    workspace?: string | string[];
    newWorkspace?: string | string[];
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
  if (requested.newWorkspace === "1") {
    const workspaceId = createContentWorkspaceId(
      `workspace_${crypto.randomUUID().replaceAll("-", "")}`,
    );
    const recovery =
      staleRecovery !== undefined
        ? new URLSearchParams({
            recovery: staleRecovery.id,
            recoverFrom: staleRecovery.sourceWorkspaceId,
          }).toString()
        : "";
    redirect(
      `/dash?workspace=${workspaceId}${recovery === "" ? "" : `&${recovery}`}`,
    );
  }
  const members =
    access.membership.role === "owner"
      ? await access.application.queries.listMembers({
          actor: access.identity,
        })
      : [];
  const mutationToken =
    access.membership.role === "owner"
      ? await createHumanMutationToken(access.identity)
      : null;
  let workspaceId;
  try {
    workspaceId =
      typeof requested.workspace === "string"
        ? createContentWorkspaceId(requested.workspace)
        : await contentWorkspaceIdForActor(actorId);
  } catch {
    notFound();
  }
  const { contentApplication, contentRevision } = await (async () => {
    try {
      const application = await loadContentRevisionApplication(
        workspaceId,
        actorId,
      );
      return {
        contentApplication: application,
        contentRevision: await application.queries.getCurrent(),
      };
    } catch (error) {
      if (
        error instanceof ContentWorkspaceAccessError ||
        error instanceof ContentRevisionConfigurationError
      ) {
        notFound();
      }
      throw error;
    }
  })();
  const initialContentStale =
    !(await contentApplication.queries.isRevisionCurrent(contentRevision));
  const contentMutationToken = await createHumanMutationToken(access.identity);
  const initialPreviewUrl = revisionPreviewGatewayUrl(
    contentRevision.workspaceId,
    contentRevision.revision,
  );

  return (
    <DashboardShell
      definition={definition}
      currentMembership={access.membership}
      members={members}
      mutationToken={mutationToken}
      contentRevision={contentRevision}
      contentMutationToken={contentMutationToken}
      initialPreviewUrl={initialPreviewUrl}
      initialContentStale={initialContentStale}
      staleRecovery={staleRecovery}
    />
  );
}
