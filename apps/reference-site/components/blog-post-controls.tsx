"use client";

import { useState } from "react";

import type { ContentRevision } from "@foundry/application";
import {
  createRichTextDocumentFromPlainText,
  serializeRichTextDocument,
} from "@foundry/site-definition";

import { sendContentRevisionAttempt } from "../src/content-revision-client";

function mutationKey(operation: string) {
  return `${operation}:${crypto.randomUUID()}`;
}

export function BlogPostControls({
  revision,
  csrfToken,
}: {
  revision: ContentRevision;
  csrfToken: string;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(body: unknown, operation: string) {
    setBusy(true);
    setMessage("");
    try {
      const result = await sendContentRevisionAttempt({
        attempt: {
          body: JSON.stringify(body),
          idempotencyKey: mutationKey(operation),
        },
        mutationToken: csrfToken,
      });
      if (!result.response.ok) {
        setMessage("The post change was rejected. Refresh and try again.");
        return;
      }
      window.location.assign(
        `/dash?workspace=${encodeURIComponent(revision.workspaceId)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="blog-posts-heading">
      <div className="dashboard-section-heading">
        <div>
          <h2 id="blog-posts-heading">Blog posts</h2>
          <p>
            Posts share this workspace’s immutable preview, approval, and
            publication path.
          </p>
        </div>
      </div>
      <form
        className="blog-post-form"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const title = String(data.get("title") ?? "").trim();
          const slug = String(data.get("slug") ?? "").trim();
          const excerpt = String(data.get("excerpt") ?? "").trim();
          const body = String(data.get("body") ?? "").trim();
          void send(
            {
              operation: "create_blog_post",
              workspaceId: revision.workspaceId,
              schemaVersion: revision.definition.schemaVersion,
              baseRevision: revision.revision,
              post: {
                id: `post_${crypto.randomUUID().replaceAll("-", "_")}`,
                slug,
                title,
                excerpt,
                seo: { title, description: excerpt },
                body: serializeRichTextDocument(
                  createRichTextDocumentFromPlainText(body),
                ),
              },
            },
            "create-blog-post",
          );
        }}
      >
        <label>
          Title
          <input name="title" required maxLength={160} />
        </label>
        <label>
          URL slug
          <input
            name="slug"
            required
            pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
            maxLength={120}
          />
        </label>
        <label>
          Excerpt
          <textarea name="excerpt" required maxLength={320} />
        </label>
        <label>
          Body
          <textarea name="body" required />
        </label>
        <button type="submit" disabled={busy}>
          Create post revision
        </button>
      </form>
      <ul className="blog-post-operations">
        {revision.definition.blog.posts.map((post) => (
          <li key={post.id}>
            <div>
              <strong>{post.title}</strong>
              <span>
                Revision {post.revision} · /blog/{post.slug}
              </span>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void send(
                  {
                    operation: "unpublish_blog_post",
                    workspaceId: revision.workspaceId,
                    schemaVersion: revision.definition.schemaVersion,
                    baseRevision: revision.revision,
                    postId: post.id,
                  },
                  "unpublish-blog-post",
                );
              }}
            >
              Prepare unpublish
            </button>
          </li>
        ))}
      </ul>
      {message === "" ? null : <p role="alert">{message}</p>}
    </section>
  );
}
