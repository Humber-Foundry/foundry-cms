import type { Metadata } from "next";

import { BlogIndex } from "@/components/blog-index";
import { installedSite } from "@/foundry/site-definition.server";
import { BlogFooter, SiteHeader } from "@/foundry/site-shell";

import "../public.css";

export const metadata: Metadata = {
  title: "Blog",
  description: "Writing and updates from this site.",
};

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
