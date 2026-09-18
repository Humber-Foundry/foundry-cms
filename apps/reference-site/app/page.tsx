import type { Metadata } from "next";

import { homePage, resolvePageSeo } from "@humber-foundry/site-definition";

import { SiteRenderer } from "@/components/site-renderer";
import { installedSite } from "@/foundry/site-definition.server";
import { publicMetadata } from "@/src/public-metadata";

import "./public.css";

export async function generateMetadata(): Promise<Metadata> {
  const definition =
    await installedSite.application.queries.getPublishedSite();

  return publicMetadata(resolvePageSeo(definition, homePage(definition)), {
    siteName: definition.site.name,
    kind: "website",
  });
}

export default async function PublicHomePage() {
  const definition =
    await installedSite.application.queries.getPublishedSite();

  return <SiteRenderer definition={definition} />;
}
