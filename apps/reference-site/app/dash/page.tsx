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
} from "@/src/content-revision-runtime";
import { createRevisionPreviewCapability } from "@/src/preview-capability-runtime";
import { referenceSiteApplication } from "@/src/reference-installation";

import "./dashboard.css";

export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{
    workspace?: string | string[];
    newWorkspace?: string | string[];
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
  const requested = await searchParams;
  if (requested.newWorkspace === "1") {
    const workspaceId = createContentWorkspaceId(
      `workspace_${crypto.randomUUID().replaceAll("-", "")}`,
    );
    redirect(`/dash?workspace=${workspaceId}`);
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
  const actorId = createContentActorId(access.membership.id);
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
  const initialPreviewCapability = await createRevisionPreviewCapability({
    identity: access.identity,
    workspaceId: contentRevision.workspaceId,
    revision: contentRevision.revision,
  });
  const initialPreviewUrl =
    `/preview/${contentRevision.workspaceId}/${contentRevision.revision}` +
    `?capability=${encodeURIComponent(initialPreviewCapability)}`;

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
    />
  );
}
