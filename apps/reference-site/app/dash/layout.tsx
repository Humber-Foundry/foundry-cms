import type { ReactNode } from "react";

import { DashboardNav } from "@/components/dashboard-nav";
import { InvitationActivation } from "@/components/invitation-activation";
import { createHumanMutationToken } from "@/src/human-mutation-runtime";
import {
  loadDashboardAccess,
  loadPublishedDefinition,
} from "@/src/dashboard-page-context";

import "./dashboard.css";
// The site's own stylesheet: the editing canvas and previews render real
// sections, and syncHostStyles copies these rules into the canvas iframe.
// Without it the canvas shows a bare skeleton instead of the real site.
import "../public.css";
import "@puckeditor/core/puck.css";

export const dynamic = "force-dynamic";

/**
 * The chrome every dashboard destination shares: who is signed in, a link back
 * to the public site, and the one navigation. Each destination supplies its own
 * `<main>` so there is exactly one per page.
 */
export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const access = await loadDashboardAccess();

  if (access.state === "invited") {
    return (
      <InvitationActivation
        csrfToken={await createHumanMutationToken(access.identity)}
        email={access.identity.email}
      />
    );
  }

  const definition = await loadPublishedDefinition();

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <a className="wordmark wordmark-dashboard" href="/dash">
          <span aria-hidden="true">F</span>
          {definition.site.name}
        </a>
        <div className="dashboard-header-meta">
          <span className="signed-in-as">
            {access.membership.email} · {access.membership.role}
          </span>
          <a href="/">View public site ↗</a>
        </div>
      </header>
      <div className="dashboard-layout">
        <DashboardNav role={access.membership.role} />
        {children}
      </div>
    </div>
  );
}
