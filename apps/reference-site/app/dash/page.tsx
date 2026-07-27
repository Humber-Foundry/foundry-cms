import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { AccessDeniedError } from "@foundry/application";

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

export default async function DashboardPage() {
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
  const workspaceId = await contentWorkspaceIdForActor(
    access.membership.id,
  );
  const contentRevision = await (
    await loadContentRevisionApplication(workspaceId)
  ).queries.getCurrent();
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
    />
  );
}
