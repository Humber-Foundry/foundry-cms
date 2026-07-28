"use client";

import { useState } from "react";

import type { ContentRevision } from "@foundry/application";
import {
  createRichTextDocumentFromPlainText,
  serializeRichTextDocument,
} from "@foundry/site-definition";

import {
  sendContentRevisionAttempt,
  type ContentRevisionAttempt,
} from "../src/content-revision-client";

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
  const [pendingAttempt, setPendingAttempt] =
    useState<ContentRevisionAttempt | null>(null);

  async function send(body: unknown, operation: string) {
    const attempt =
      pendingAttempt ?? {
        body: JSON.stringify(body),
        idempotencyKey: mutationKey(operation),
      };
    setPendingAttempt(attempt);
    setBusy(true);
    setMessage("");
    try {
      const result = await sendContentRevisionAttempt({
        attempt,
        mutationToken: csrfToken,
      });
      setPendingAttempt(null);
      if (!result.response.ok) {
        setMessage("The post change was rejected. Refresh and try again.");
        return;
      }
      window.location.assign(
        `/dash?workspace=${encodeURIComponent(revision.workspaceId)}`,
      );
    } catch {
      setMessage(
        "The result is not yet known. Retry the exact post change safely.",
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
                id: crypto.randomUUID(),
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
        <button type="submit" disabled={busy || pendingAttempt !== null}>
          Create post revision
        </button>
      </form>
      <ul className="blog-post-operations">
        {revision.definition.blog.posts.map((post) => (
          <li key={post.id}>
            <div>
              <strong>{post.title}</strong>
              <span>
                Revision {post.revision} · {post.visibility} · /blog/{post.slug}
              </span>
            </div>
            <button
              type="button"
              disabled={
                busy ||
                pendingAttempt !== null
              }
              onClick={() => {
                const operation =
                  post.visibility === "public"
                    ? "unpublish_blog_post"
                    : "republish_blog_post";
                void send(
                  {
                    operation,
                    workspaceId: revision.workspaceId,
                    schemaVersion: revision.definition.schemaVersion,
                    baseRevision: revision.revision,
                    postId: post.id,
                  },
                  operation,
                );
              }}
            >
              {post.visibility === "public"
                ? "Prepare unpublish"
                : "Prepare republish"}
            </button>
          </li>
        ))}
      </ul>
      {pendingAttempt === null ? null : (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void send(JSON.parse(pendingAttempt.body), "retry-blog-post");
          }}
        >
          Retry pending post change
        </button>
      )}
      {message === "" ? null : <p role="alert">{message}</p>}
    </section>
  );
}
