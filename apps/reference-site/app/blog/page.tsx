import type { Metadata } from "next";

import { resolveBlogIndexSeo } from "@humber-foundry/site-definition";

import { BlogIndex } from "@/components/blog-index";
import { installedSite } from "@/foundry/site-definition.server";
import { BlogFooter, SiteHeader } from "@/foundry/site-shell";
import { publicMetadata } from "@/src/public-metadata";

import "../public.css";

export async function generateMetadata(): Promise<Metadata> {
  const definition = await installedSite.application.queries.getPublishedSite();
  return publicMetadata(resolveBlogIndexSeo(definition), {
    siteName: definition.site.name,
    kind: "website",
  });
}

export default async function BlogPage() {
  const definition = await installedSite.application.queries.getPublishedSite();
  return (
    <div className="site-canvas">
      <SiteHeader definition={definition} />
      <BlogIndex definition={definition} />
      <BlogFooter definition={definition} />
    </div>
  );
}
