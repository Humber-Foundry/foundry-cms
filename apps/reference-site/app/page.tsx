import type { Metadata } from "next";

import { SiteRenderer } from "@/components/site-renderer";
import { installedSite } from "@/foundry/site-definition.server";

import "./public.css";

export async function generateMetadata(): Promise<Metadata> {
  const definition =
    await installedSite.application.queries.getPublishedSite();

  return {
    title: definition.home.seo.title,
    description: definition.home.seo.description,
  };
}

export default async function PublicHomePage() {
  const definition =
    await installedSite.application.queries.getPublishedSite();

  return <SiteRenderer definition={definition} />;
}
