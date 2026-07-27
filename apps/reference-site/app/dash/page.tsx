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
import { referenceSiteApplication } from "@/src/reference-installation";
import { loadPublicFormOperationsDashboard } from "@/src/public-form-delivery-health-runtime";

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
  const mutationToken = await createHumanMutationToken(access.identity);
  const formOperations = await loadPublicFormOperationsDashboard(access);

  return (
    <DashboardShell
      definition={definition}
      currentMembership={access.membership}
      members={members}
      mutationToken={mutationToken}
      formDeliveryHealth={formOperations.health}
      failedFormDeliveries={formOperations.failedDeliveries}
      suspectedSpam={formOperations.suspectedSpam}
    />
  );
}
