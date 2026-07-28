import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { BlogPostRenderer } from "@/components/blog-post-renderer";
import { referenceSiteApplication } from "@/src/reference-installation";

import "../../public.css";

type BlogPostPageProps = {
  params: Promise<{ slug: string }>;
};

async function loadPost(props: BlogPostPageProps) {
  const definition =
    await referenceSiteApplication.queries.getPublishedSite();
  const { slug } = await props.params;
  const post = definition.blog.posts.find(
    (candidate) => candidate.slug === slug,
  );
  if (post === undefined) {
    notFound();
  }
  return { definition, post };
}

export async function generateMetadata(
  props: BlogPostPageProps,
): Promise<Metadata> {
  const { post } = await loadPost(props);
  return {
    title: post.seo.title,
    description: post.seo.description,
  };
}

export default async function BlogPostPage(props: BlogPostPageProps) {
  const { definition, post } = await loadPost(props);
  return <BlogPostRenderer definition={definition} post={post} />;
}
