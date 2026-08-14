"use client";

import { useState } from "react";

import type { ContentRevision } from "@humber-foundry/application";
import {
  parseSerializedRichTextDocument,
  serializeRichTextDocument,
  type BlogPost,
  type BlogPostId,
  type RichTextDocument,
  type SerializedRichTextDocument,
} from "@humber-foundry/site-definition";

import { RichTextEditor } from "./rich-text-editor";
import { ComposerActions, emptyRichTextBody } from "./composer";
import {
  sendContentRevisionAttempt,
  type ContentRevisionAttempt,
} from "../src/content-revision-client";

function mutationKey(operation: string) {
  return `${operation}:${crypto.randomUUID()}`;
}

export function blogPostPlainText(document: RichTextDocument): string {
  const lines: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    if ("text" in value && typeof value.text === "string") {
      lines.push(value.text);
      return;
    }
    if ("children" in value && Array.isArray(value.children)) {
      const before = lines.length;
      value.children.forEach(visit);
      if (before !== lines.length) lines.push("\n");
    }
  };
  visit(document);
  return lines.join("").replace(/\n{2,}/gu, "\n").trim();
}

export function blogPostPreviewUrl(previewUrl: string, slug: string): string {
  const url = new URL(
    previewUrl,
    typeof window === "undefined" ? "http://localhost" : window.location.origin,
  );
  url.pathname = `${url.pathname.replace(/\/$/u, "")}/blog/${encodeURIComponent(slug)}`;
  return url.toString();
}

export function blogPostLifecycleAction(
  post: Pick<BlogPost, "id" | "targetVisibility">,
  verifiedPublicPostIds: ReadonlySet<BlogPostId>,
): "unpublish_blog_post" | "republish_blog_post" | null {
  if (
    post.targetVisibility === "public" &&
    verifiedPublicPostIds.has(post.id)
  ) {
    return "unpublish_blog_post";
  }
  if (
    post.targetVisibility === "unpublished" &&
    !verifiedPublicPostIds.has(post.id)
  ) {
    return "republish_blog_post";
  }
  return null;
}

/** The web address a title suggests: lowercase words joined with hyphens. */
function blogPostSlugFromTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .replace(/[’']/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120)
    .replace(/-+$/gu, "");
}

/**
 * The summary shown in the blog list. The owner can write one; left empty,
 * the opening lines of the post are used, and an empty post falls back to
 * its title so the saved draft always validates.
 */
function blogPostSummary(
  summary: string,
  body: SerializedRichTextDocument,
  title: string,
): string {
  const written = summary.trim();
  if (written !== "") return written.slice(0, 320);
  const opening = blogPostPlainText(parseSerializedRichTextDocument(body))
    .replace(/\s+/gu, " ")
    .trim();
  const source = opening === "" ? title : opening;
  if (source.length <= 200) return source;
  return `${source.slice(0, 200).replace(/\s+\S*$/u, "")}…`;
}

/**
 * The form for one post: a title, a body you write into, and the
 * details (summary and web address) folded away until they are wanted.
 */
function PostComposer({
  editorId,
  initialPost,
  busy,
  saveLabel,
  onSave,
  onCancel,
}: {
  editorId: string;
  initialPost?: Pick<BlogPost, "title" | "slug" | "excerpt" | "body">;
  busy: boolean;
  saveLabel: string;
  onSave(post: {
    title: string;
    slug: string;
    excerpt: string;
    body: SerializedRichTextDocument;
  }): void;
  onCancel?(): void;
}) {
  const [title, setTitle] = useState(initialPost?.title ?? "");
  const [slug, setSlug] = useState(initialPost?.slug ?? "");
  const [slugEdited, setSlugEdited] = useState(initialPost !== undefined);
  const [summary, setSummary] = useState(initialPost?.excerpt ?? "");
  const [body, setBody] = useState<SerializedRichTextDocument>(() =>
    initialPost === undefined
      ? emptyRichTextBody()
      : serializeRichTextDocument(initialPost.body),
  );
  const [bodyInvalid, setBodyInvalid] = useState(false);
  const effectiveSlug = slugEdited ? slug : blogPostSlugFromTitle(title);

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({
          title: title.trim(),
          slug: effectiveSlug,
          excerpt: blogPostSummary(summary, body, title.trim()),
          body,
        });
      }}
    >
      <label className="composer-title">
        <span>Title</span>
        <input
          name="title"
          required
          maxLength={160}
          placeholder="Post title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <RichTextEditor
        id={editorId}
        label="Post body"
        describedBy={`${editorId}-hint`}
        value={body}
        disabled={busy}
        invalid={bodyInvalid}
        onChange={setBody}
        onValidationChange={setBodyInvalid}
      />
      <p className="composer-hint" id={`${editorId}-hint`}>
        Write the post here. Use the buttons above for headings, bold text,
        lists and links.
      </p>
      <details className="composer-settings">
        <summary>Post settings — summary and web address</summary>
        <div>
          <label>
            <span>Summary — shown in the blog list</span>
            <textarea
              name="excerpt"
              maxLength={320}
              placeholder="Left empty, the first lines of the post are used."
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
            />
          </label>
          <label>
            <span>Web address</span>
            <span className="composer-slug">
              <span aria-hidden="true">/blog/</span>
              <input
                name="slug"
                required
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                maxLength={120}
                value={effectiveSlug}
                onChange={(event) => {
                  setSlugEdited(true);
                  setSlug(event.target.value);
                }}
              />
            </span>
          </label>
        </div>
      </details>
      <ComposerActions
        busy={busy}
        saveLabel={saveLabel}
        blocked={bodyInvalid}
        onCancel={onCancel}
      />
    </form>
  );
}

/** The plain words for where a post stands, and the one action that fits. */
function blogPostStanding(
  post: Pick<BlogPost, "id" | "targetVisibility">,
  verifiedPublicPostIds: ReadonlySet<BlogPostId>,
): Readonly<{
  label: string;
  operation: "unpublish_blog_post" | "republish_blog_post" | null;
  actionLabel: string | null;
}> {
  const operation = blogPostLifecycleAction(post, verifiedPublicPostIds);
  if (operation === "unpublish_blog_post") {
    return { label: "On your site", operation, actionLabel: "Unpublish" };
  }
  if (operation === "republish_blog_post") {
    return {
      label: "Draft — not on your site",
      operation,
      actionLabel: "Publish",
    };
  }
  return {
    label:
      post.targetVisibility === "public"
        ? "Goes live when you next publish the site"
        : "Comes off the site when you next publish",
    operation: null,
    actionLabel: null,
  };
}

export function BlogPostControls({
  revision,
  csrfToken,
  verifiedPublicPostIds,
}: {
  revision: ContentRevision;
  csrfToken: string;
  verifiedPublicPostIds: ReadonlyArray<BlogPostId>;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [mutationToken, setMutationToken] = useState(csrfToken);
  const [pendingAttempt, setPendingAttempt] =
    useState<ContentRevisionAttempt | null>(null);
  const posts = revision.definition.blog.posts;
  // The composer opens by itself when there is nothing to list yet.
  const [writingNew, setWritingNew] = useState(posts.length === 0);
  const [editingPostId, setEditingPostId] = useState<string | null>(null);
  const verifiedPublicPosts = new Set(verifiedPublicPostIds);

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
        mutationToken,
      });
      setMutationToken(result.mutationToken);
      setPendingAttempt(null);
      if (!result.response.ok) {
        setMessage("The change was not accepted. Refresh and try again.");
        return;
      }
      // Reload the destination the owner is on — Blog — with the workspace
      // pinned. The old dashboard had one page to return to; this component
      // now renders on its own route.
      window.location.assign(
        `${window.location.pathname}?workspace=${encodeURIComponent(
          revision.workspaceId,
        )}`,
      );
    } catch {
      setMessage(
        "The result is not yet known. Retrying sends the exact same change, so nothing is duplicated.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function openPostPreview(post: BlogPost) {
    const popup = window.open("", "_blank");
    if (popup !== null) popup.opener = null;
    setBusy(true);
    setMessage("");
    try {
      const result = await sendContentRevisionAttempt({
        attempt: {
          body: JSON.stringify({
            operation: "open_preview",
            workspaceId: revision.workspaceId,
            revision: revision.revision,
          }),
          idempotencyKey: mutationKey("open-blog-preview"),
        },
        mutationToken,
      });
      setMutationToken(result.mutationToken);
      if (
        !result.response.ok ||
        typeof result.body !== "object" ||
        result.body === null ||
        !("previewUrl" in result.body) ||
        typeof result.body.previewUrl !== "string"
      ) {
        throw new Error("blog_preview_access_failed");
      }
      const destination = blogPostPreviewUrl(result.body.previewUrl, post.slug);
      if (popup === null) {
        window.open(destination, "_blank", "noopener,noreferrer");
      } else {
        popup.location.href = destination;
      }
    } catch {
      popup?.close();
      setMessage("The preview could not be opened. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function savePost(
    post: Readonly<{
      title: string;
      slug: string;
      excerpt: string;
      body: SerializedRichTextDocument;
    }>,
    existingPostId?: string,
  ) {
    const shared = {
      workspaceId: revision.workspaceId,
      schemaVersion: revision.definition.schemaVersion,
      baseRevision: revision.revision,
    };
    const seo = { title: post.title, description: post.excerpt };
    void send(
      existingPostId === undefined
        ? {
            operation: "create_blog_post",
            ...shared,
            post: { id: crypto.randomUUID(), ...post, seo },
          }
        : {
            operation: "edit_blog_post",
            ...shared,
            postId: existingPostId,
            post: { ...post, seo },
          },
      existingPostId === undefined ? "create-blog-post" : "edit-blog-post",
    );
  }

  return (
    <section aria-labelledby="blog-posts-heading">
      <div className="dashboard-section-heading">
        <div>
          <h2 id="blog-posts-heading">Posts</h2>
          <p>
            Write a post, preview it privately, and publish it when it is
            ready.
          </p>
        </div>
        {writingNew || editingPostId !== null ? null : (
          <button
            type="button"
            className="button button-primary"
            disabled={busy}
            onClick={() => setWritingNew(true)}
          >
            New post
          </button>
        )}
      </div>
      {writingNew ? (
        <PostComposer
          editorId="post-body"
          busy={busy || pendingAttempt !== null}
          saveLabel={busy ? "Saving…" : "Save draft"}
          onSave={(post) => savePost(post)}
          onCancel={
            posts.length === 0 ? undefined : () => setWritingNew(false)
          }
        />
      ) : null}
      <ul className="post-list">
        {posts.map((post) => {
          const standing = blogPostStanding(post, verifiedPublicPosts);
          const standingOperation = standing.operation;
          if (editingPostId === post.id) {
            return (
              <li key={post.id} className="post-list-editing">
                <PostComposer
                  editorId="post-body"
                  initialPost={post}
                  busy={busy || pendingAttempt !== null}
                  saveLabel={busy ? "Saving…" : "Save changes"}
                  onSave={(edited) => savePost(edited, post.id)}
                  onCancel={() => setEditingPostId(null)}
                />
              </li>
            );
          }
          return (
            <li key={post.id}>
              <div className="post-list-summary">
                <strong>{post.title}</strong>
                <span>{standing.label}</span>
              </div>
              <div className="post-list-actions">
                <button
                  type="button"
                  className="copy-button"
                  disabled={busy}
                  onClick={() => {
                    setWritingNew(false);
                    setEditingPostId(post.id);
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="copy-button"
                  disabled={busy}
                  onClick={() => void openPostPreview(post)}
                >
                  Preview ↗
                </button>
                {standingOperation === null ? null : (
                  <button
                    type="button"
                    className="copy-button"
                    disabled={busy || pendingAttempt !== null}
                    onClick={() => {
                      void send(
                        {
                          operation: standingOperation,
                          workspaceId: revision.workspaceId,
                          schemaVersion: revision.definition.schemaVersion,
                          baseRevision: revision.revision,
                          postId: post.id,
                        },
                        standingOperation,
                      );
                    }}
                  >
                    {standing.actionLabel}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {pendingAttempt === null ? null : (
        <button
          type="button"
          className="copy-button"
          disabled={busy}
          onClick={() => {
            void send(JSON.parse(pendingAttempt.body), "retry-blog-post");
          }}
        >
          Retry the last change
        </button>
      )}
      {message === "" ? null : <p role="alert">{message}</p>}
    </section>
  );
}
