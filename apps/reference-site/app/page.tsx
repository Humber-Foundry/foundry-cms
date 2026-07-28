import type { Metadata } from "next";

import { SiteRenderer } from "@/components/site-renderer";
import { referenceSiteApplication } from "@/src/reference-installation";

import "./public.css";

export async function generateMetadata(): Promise<Metadata> {
  const definition =
    await referenceSiteApplication.queries.getPublishedSite();

  return {
    title: definition.home.seo.title,
    description: definition.home.seo.description,
  };
}

export default async function PublicHomePage() {
  const definition =
    await referenceSiteApplication.queries.getPublishedSite();

  return <SiteRenderer definition={definition} />;
}
