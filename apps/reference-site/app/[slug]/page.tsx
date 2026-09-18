import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SiteRenderer } from "@/components/site-renderer";
import { installedSite } from "@/foundry/site-definition.server";
import { findPublicPage, pageRouteMetadata } from "@/src/public-page";

import "../public.css";

type SitePageRouteProps = {
  params: Promise<{ slug: string }>;
};

async function loadSitePage(props: SitePageRouteProps) {
  const definition =
    await installedSite.application.queries.getPublishedSite();
  const { slug } = await props.params;
  const page = findPublicPage(definition, slug);
  if (page === null) {
    notFound();
  }
  return { definition, page };
}

export async function generateMetadata(
  props: SitePageRouteProps,
): Promise<Metadata> {
  const { definition, page } = await loadSitePage(props);
  return pageRouteMetadata(definition, page);
}

export default async function SitePageRoute(props: SitePageRouteProps) {
  const { definition, page } = await loadSitePage(props);
  return <SiteRenderer definition={definition} page={page} />;
}
