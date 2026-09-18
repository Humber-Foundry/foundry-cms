import type { Metadata } from "next";

import { homePage } from "@humber-foundry/site-definition";

import { SiteRenderer } from "@/components/site-renderer";
import { installedSite } from "@/foundry/site-definition.server";
import { pageRouteMetadata } from "@/src/public-page";

import "./public.css";

export async function generateMetadata(): Promise<Metadata> {
  const definition =
    await installedSite.application.queries.getPublishedSite();

  return pageRouteMetadata(definition, homePage(definition));
}

export default async function PublicHomePage() {
  const definition =
    await installedSite.application.queries.getPublishedSite();

  return <SiteRenderer definition={definition} page={homePage(definition)} />;
}
