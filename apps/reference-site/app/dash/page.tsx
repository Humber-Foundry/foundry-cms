import { notFound } from "next/navigation";

import { DashboardShell } from "@/components/dashboard-shell";
import { authorizeDashboard } from "@/src/dashboard-access";
import { referenceSiteApplication } from "@/src/reference-installation";

import "./dashboard.css";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const access = authorizeDashboard({
    runtime: process.env.NODE_ENV,
  });

  if (!access.allowed) {
    notFound();
  }

  const definition =
    await referenceSiteApplication.queries.getPublishedSite();

  return <DashboardShell definition={definition} />;
}
