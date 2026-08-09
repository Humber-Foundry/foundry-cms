import { describe, expect, it } from "vitest";

import {
  createBlogPostId,
  type BlogPost,
  type BlogPostId,
} from "@humber-foundry/site-definition";

import { blogPostLifecycleAction } from "./blog-post-controls";

describe("blog post lifecycle controls", () => {
  const postId = createBlogPostId(
    "00000000-0000-4000-8000-00000000000f",
  );
  const verified = new Set<BlogPostId>([postId]);
  const absent = new Set<BlogPostId>();

  function post(targetVisibility: BlogPost["targetVisibility"]) {
    return { id: postId, targetVisibility };
  }

  it("offers unpublish only for a post verified public", () => {
    expect(blogPostLifecycleAction(post("public"), verified)).toBe(
      "unpublish_blog_post",
    );
    expect(blogPostLifecycleAction(post("public"), absent)).toBeNull();
  });

  it("offers republish only after public absence is verified", () => {
    expect(blogPostLifecycleAction(post("unpublished"), absent)).toBe(
      "republish_blog_post",
    );
    expect(
      blogPostLifecycleAction(post("unpublished"), verified),
    ).toBeNull();
  });
});
