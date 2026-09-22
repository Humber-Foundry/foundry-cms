"use client";

import { useState } from "react";

import {
  formatSeoKeywords,
  parseSeoKeywords,
  parseSerializedRichTextDocument,
  seoFieldHints,
  seoKeywordLimit,
  serializeRichTextDocument,
  toSeoShareImage,
  type BlogPost,
  type SeoMetadata,
  type SeoShareImage,
  type SerializedRichTextDocument,
} from "@humber-foundry/site-definition";

import { blogPostPlainText } from "./blog-operations";
import { ChangePhotoField, type EditorMediaContext } from "./change-photo-field";
import { ComposerActions, emptyRichTextBody } from "./composer";
import { RichTextEditor } from "./rich-text-editor";

/** What the writing box hands back when the owner saves. */
export type BlogPostDraft = Readonly<{
  title: string;
  slug: string;
  excerpt: string;
  seo: SeoMetadata;
  mainImage: SeoShareImage | null;
  body: SerializedRichTextDocument;
}>;

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
 *
 * It lives on its own screen now — `/dash/blog/new` for a new post and
 * `/dash/blog/<postId>` for a saved one (#230).
 */
export function BlogPostComposer({
  editorId,
  initialPost,
  media,
  busy,
  saveLabel,
  onSave,
  onCancel,
}: {
  editorId: string;
  initialPost?: Pick<
    BlogPost,
    "title" | "slug" | "excerpt" | "body" | "seo" | "mainImage"
  >;
  media: EditorMediaContext;
  busy: boolean;
  saveLabel: string;
  onSave(post: BlogPostDraft): void;
  /** What the "Cancel" control does. Every Blog screen gives it one. */
  onCancel(): void;
}) {
  const [title, setTitle] = useState(initialPost?.title ?? "");
  const [slug, setSlug] = useState(initialPost?.slug ?? "");
  const [slugEdited, setSlugEdited] = useState(initialPost !== undefined);
  const [summary, setSummary] = useState(initialPost?.excerpt ?? "");
  const [seoTitle, setSeoTitle] = useState(initialPost?.seo.title ?? "");
  const [seoDescription, setSeoDescription] = useState(
    initialPost?.seo.description ?? "",
  );
  const [keywords, setKeywords] = useState(
    formatSeoKeywords(initialPost?.seo.keywords ?? []),
  );
  // The schema refuses a longer list. Say so here, next to the box, rather
  // than letting the save come back with a generic schema complaint.
  const tooManyKeywords = parseSeoKeywords(keywords).length > seoKeywordLimit;
  const [shareImageUrl, setShareImageUrl] = useState(
    initialPost?.seo.shareImage?.url ?? "",
  );
  const [shareImageAlt, setShareImageAlt] = useState(
    initialPost?.seo.shareImage?.alt ?? "",
  );
  const [mainImageUrl, setMainImageUrl] = useState(
    initialPost?.mainImage?.url ?? "",
  );
  const [mainImageAlt, setMainImageAlt] = useState(
    initialPost?.mainImage?.alt ?? "",
  );
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
          seo: {
            title: seoTitle.trim(),
            description: seoDescription.trim(),
            keywords: parseSeoKeywords(keywords),
            shareImage: toSeoShareImage(shareImageUrl, shareImageAlt),
          },
          mainImage: toSeoShareImage(mainImageUrl, mainImageAlt),
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
      <div className="composer-main-image">
        <ChangePhotoField
          label="Main image — shown large at the top of the post"
          value={mainImageUrl}
          onChange={setMainImageUrl}
          media={media}
        />
        <label>
          <span>Main image description</span>
          <small className="composer-hint">
            Describe the picture for people who cannot see it.
          </small>
          <input
            name="mainImageAlt"
            maxLength={300}
            value={mainImageAlt}
            onChange={(event) => setMainImageAlt(event.target.value)}
          />
        </label>
      </div>
      <RichTextEditor
        id={editorId}
        label="Post body"
        describedBy={`${editorId}-hint`}
        value={body}
        disabled={busy}
        invalid={bodyInvalid}
        media={media}
        onChange={setBody}
        onValidationChange={setBodyInvalid}
      />
      <p className="composer-hint" id={`${editorId}-hint`}>
        Write the post here. Use the buttons above for headings, bold text,
        lists, links and photos.
      </p>
      <details className="composer-settings">
        <summary>Post settings — summary shown in the blog list</summary>
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
        </div>
      </details>
      <details className="composer-settings">
        <summary>SEO and sharing — how this post looks in search and when shared</summary>
        <div>
          {/*
            The web address leads this section because it is the owner's only
            control over the post's canonical URL. See ADR-0008.
          */}
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
          <label>
            <span>SEO title</span>
            <small className="composer-hint">
              {seoFieldHints.post.title}
            </small>
            <input
              name="seoTitle"
              maxLength={300}
              value={seoTitle}
              onChange={(event) => setSeoTitle(event.target.value)}
            />
          </label>
          <label>
            <span>SEO description</span>
            <small className="composer-hint">
              {seoFieldHints.post.description}
            </small>
            <textarea
              name="seoDescription"
              maxLength={1000}
              value={seoDescription}
              onChange={(event) => setSeoDescription(event.target.value)}
            />
          </label>
          <label>
            <span>Keywords</span>
            <small className="composer-hint">{seoFieldHints.keywords}</small>
            <input
              name="seoKeywords"
              value={keywords}
              aria-invalid={tooManyKeywords}
              aria-describedby="seo-keywords-error"
              onChange={(event) => setKeywords(event.target.value)}
            />
            <small className="composer-error" id="seo-keywords-error">
              {tooManyKeywords ? seoFieldHints.tooManyKeywords : ""}
            </small>
          </label>
          <ChangePhotoField
            label="Thumbnail — shown in the blog list and when the post is shared"
            value={shareImageUrl}
            onChange={setShareImageUrl}
            media={media}
          />
          <p className="composer-hint">{seoFieldHints.shareImageUrl}</p>
          <label>
            <span>Thumbnail description</span>
            <small className="composer-hint">
              {seoFieldHints.shareImageAlt}
            </small>
            <input
              name="seoShareImageAlt"
              maxLength={300}
              value={shareImageAlt}
              onChange={(event) => setShareImageAlt(event.target.value)}
            />
          </label>
        </div>
      </details>
      <ComposerActions
        busy={busy}
        saveLabel={saveLabel}
        blocked={bodyInvalid || tooManyKeywords}
        onCancel={onCancel}
      />
    </form>
  );
}
