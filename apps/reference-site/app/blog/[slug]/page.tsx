import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { BlogPostRenderer } from "@/components/blog-post-renderer";
import {
  blogPostMetadata,
  findPublicBlogPost,
} from "@/src/blog-post-page";
import { installedSite } from "@/foundry/site-definition.server";

import "../../public.css";

type BlogPostPageProps = {
  params: Promise<{ slug: string }>;
};

async function loadPost(props: BlogPostPageProps) {
  const definition =
    await installedSite.application.queries.getPublishedSite();
  const { slug } = await props.params;
  const post = findPublicBlogPost(definition, slug);
  if (post === null) {
    notFound();
  }
  return { definition, post };
}

export async function generateMetadata(
  props: BlogPostPageProps,
): Promise<Metadata> {
  const { definition, post } = await loadPost(props);
  return blogPostMetadata(definition, post);
}

export default async function BlogPostPage(props: BlogPostPageProps) {
  const { definition, post } = await loadPost(props);
  return <BlogPostRenderer definition={definition} post={post} />;
}
