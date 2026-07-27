import type { Metadata } from "next";

import { SiteRenderer } from "@/components/site-renderer";
import { referenceSiteApplication } from "@/src/reference-installation";
import { loadPublicMediaPresentation } from "@/src/media-asset-runtime";

import "./public.css";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const definition =
    await referenceSiteApplication.queries.getPublishedSite();

  return {
    title: definition.home.seo.title,
    description: definition.home.seo.description,
  };
}

export default async function PublicHomePage() {
  const [definition, media] = await Promise.all([
    referenceSiteApplication.queries.getPublishedSite(),
    loadPublicMediaPresentation(),
  ]);

  return <SiteRenderer definition={definition} media={media} />;
}
