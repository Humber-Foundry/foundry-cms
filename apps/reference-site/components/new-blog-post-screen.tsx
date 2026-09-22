"use client";

import type { ContentRevision } from "@humber-foundry/application";

import { BlogCommandFeedback } from "./blog-command-feedback";
import { blogListHref } from "./blog-links";
import { revisionCommandBase } from "./blog-operations";
import { BlogPostComposer } from "./blog-post-composer";
import type { SiteImageTile } from "../src/site-used-photos";
import { useBlogCommands } from "./use-blog-commands";

/**
 * The writing box for one new post, on its own screen (#230).
 *
 * Saving stores a private draft and nothing else. The person is then taken
 * back to the posts list, where the new post is one row, so the next steps —
 * the preview, the schedule and the publish — are in front of them.
 */
export function NewBlogPostScreen({
  revision,
  csrfToken,
  siteImages,
}: {
  revision: ContentRevision;
  csrfToken: string;
  siteImages: ReadonlyArray<SiteImageTile>;
}) {
  const listHref = blogListHref(revision.workspaceId);
  const commands = useBlogCommands({ csrfToken, returnTo: listHref });

  return (
    <section aria-label="New post">
      <BlogPostComposer
        editorId="post-body"
        media={{
          csrfToken: commands.mutationToken,
          workspaceId: revision.workspaceId,
          siteImages,
        }}
        busy={commands.busy || commands.pendingAttempt !== null}
        saveLabel={commands.busy ? "Saving…" : "Save draft"}
        onSave={(post) => {
          // Blank SEO fields are saved blank on purpose. The renderer fills
          // them from the post title and summary, so a later edit to either
          // keeps the search result and the link preview in step.
          void commands.sendRevisionCommand(
            {
              operation: "create_blog_post",
              ...revisionCommandBase(revision),
              post: { id: crypto.randomUUID(), ...post },
            },
            "create-blog-post",
          );
        }}
        onCancel={() => window.location.assign(listHref)}
      />
      <BlogCommandFeedback commands={commands} />
    </section>
  );
}
