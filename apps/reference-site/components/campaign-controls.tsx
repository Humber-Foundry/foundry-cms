"use client";

import { useState } from "react";

import {
  type BlogPostArtifactFingerprint,
  type Campaign,
  type CampaignLifecycleState,
  type CampaignRevision,
  type RenderedCampaign,
} from "@humber-foundry/application";
import {
  mediaAssetIdFromPublishedPath,
  parseSerializedRichTextDocument,
  seoFieldHints,
  serializeRichTextDocument,
  toSeoShareImage,
  type RichTextDocument,
  type SerializedRichTextDocument,
  type BlogPost,
} from "@humber-foundry/site-definition";

import { RichTextEditor } from "./rich-text-editor";
import { RichTextRenderer } from "./rich-text-renderer";
import { ChangePhotoField, type EditorMediaContext } from "./change-photo-field";
import { ComposerActions, emptyRichTextBody } from "./composer";

/**
 * The address the dashboard preview draws for one campaign image. A campaign
 * stores each image as an absolute address so the sent email can load it. A
 * gallery photo's address is the site's own `/api/media/<assetId>` route made
 * absolute; the preview draws it by its same-origin path so it loads while the
 * dashboard runs on any host. An external picture is drawn as written.
 */
function campaignPreviewSrc(url: string): string {
  try {
    const path = new URL(
      url,
      typeof window === "undefined" ? "http://localhost" : window.location.origin,
    ).pathname;
    return mediaAssetIdFromPublishedPath(path) !== null ? path : url;
  } catch {
    return url;
  }
}

/** The email body with every image address drawn by its same-origin path. */
function previewEmailContent(document: RichTextDocument): RichTextDocument {
  return {
    ...document,
    children: document.children.map((block) =>
      block.type === "image"
        ? { ...block, src: campaignPreviewSrc(block.src) }
        : block,
    ),
  };
}

/**
 * Plain words for a campaign's lifecycle state. Typed by the union rather
 * than by string, so adding a state to CampaignLifecycleState fails the build
 * here until it has a label, instead of falling through to a generated one.
 */
const campaignStateLabels: Readonly<Record<CampaignLifecycleState, string>> = {
  draft: "Draft",
};

/**
 * The form for one email: a subject, the email itself, and the inbox
 * details below it. Used both for a new email and for editing a saved one;
 * the key on the caller resets the fields when the saved revision changes.
 */
function EmailComposer({
  heading,
  initialRevision,
  media,
  busy,
  saveLabel,
  onSave,
  onCancel,
}: {
  heading: string;
  initialRevision?: CampaignRevision;
  media: EditorMediaContext;
  busy: boolean;
  saveLabel: string;
  onSave(email: {
    subject: string;
    previewText: string;
    headerImage: CampaignRevision["headerImage"];
    shareImage: CampaignRevision["shareImage"];
    callToAction: { label: string; href: string };
    emailContent: SerializedRichTextDocument;
  }): void;
  onCancel?(): void;
}) {
  const [subject, setSubject] = useState(initialRevision?.subject ?? "");
  const [previewText, setPreviewText] = useState(
    initialRevision?.previewText ?? "",
  );
  const [ctaLabel, setCtaLabel] = useState(
    initialRevision?.callToAction.label ?? "",
  );
  const [ctaHref, setCtaHref] = useState(
    initialRevision?.callToAction.href ?? "",
  );
  const [headerImageUrl, setHeaderImageUrl] = useState(
    initialRevision?.headerImage?.url ?? "",
  );
  const [headerImageAlt, setHeaderImageAlt] = useState(
    initialRevision?.headerImage?.alt ?? "",
  );
  const [shareImageUrl, setShareImageUrl] = useState(
    initialRevision?.shareImage?.url ?? "",
  );
  const [shareImageAlt, setShareImageAlt] = useState(
    initialRevision?.shareImage?.alt ?? "",
  );
  const [content, setContent] = useState<SerializedRichTextDocument>(() =>
    initialRevision === undefined
      ? emptyRichTextBody()
      : serializeRichTextDocument(initialRevision.emailContent),
  );
  const [contentInvalid, setContentInvalid] = useState(false);

  return (
    <form
      className="composer"
      aria-label={heading}
      onSubmit={(event) => {
        event.preventDefault();
        onSave({
          subject: subject.trim(),
          previewText: previewText.trim(),
          headerImage: toSeoShareImage(headerImageUrl, headerImageAlt),
          shareImage: toSeoShareImage(shareImageUrl, shareImageAlt),
          callToAction: { label: ctaLabel.trim(), href: ctaHref.trim() },
          emailContent: content,
        });
      }}
    >
      <label className="composer-title">
        <span>Subject</span>
        <input
          name="subject"
          required
          maxLength={200}
          placeholder="Email subject"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
        />
      </label>
      <div className="composer-main-image">
        <ChangePhotoField
          label="Header image — shown at the top of the email"
          value={headerImageUrl}
          onChange={setHeaderImageUrl}
          media={media}
        />
        <label>
          <span>Header image description</span>
          <small className="composer-hint">
            Describe the picture for people who cannot see it.
          </small>
          <input
            name="headerImageAlt"
            maxLength={300}
            value={headerImageAlt}
            onChange={(event) => setHeaderImageAlt(event.target.value)}
          />
        </label>
      </div>
      <RichTextEditor
        id="campaign-email-content"
        label="Email body"
        describedBy="campaign-email-content-hint"
        value={content}
        disabled={busy}
        invalid={contentInvalid}
        media={media}
        onChange={setContent}
        onValidationChange={setContentInvalid}
      />
      <p className="composer-hint" id="campaign-email-content-hint">
        Write the email here. Use the buttons above for headings, links and
        photos. Formatting is kept exactly as you set it.
      </p>
      <div className="composer-settings-open">
        {/*
          The same SEO and sharing block the page and post editors show, named
          in the words an email uses. The subject above is this campaign's
          title, so the section holds the two lines below it and the picture.
        */}
        <fieldset className="composer-section">
          <legend>SEO and sharing — how this email looks in an inbox</legend>
          <p className="composer-hint">
            The subject above is the first line an inbox shows.
          </p>
          <label>
            <span>Preview line — shown after the subject in inboxes</span>
            <textarea
              name="previewText"
              required
              maxLength={1000}
              value={previewText}
              onChange={(event) => setPreviewText(event.target.value)}
            />
          </label>
          <ChangePhotoField
            label="Share image — shown where this email is previewed or shared"
            value={shareImageUrl}
            onChange={setShareImageUrl}
            media={media}
          />
          <p className="composer-hint">
            Leave blank to use the header image.
          </p>
          <label>
            <span>Share image description</span>
            <small className="composer-hint">
              {seoFieldHints.shareImageAlt}
            </small>
            <input
              name="shareImageAlt"
              maxLength={300}
              value={shareImageAlt}
              onChange={(event) => setShareImageAlt(event.target.value)}
            />
          </label>
        </fieldset>
        <label>
          <span>Button label</span>
          <input
            name="callToActionLabel"
            required
            maxLength={200}
            placeholder="Read the post"
            value={ctaLabel}
            onChange={(event) => setCtaLabel(event.target.value)}
          />
        </label>
        <label>
          <span>Button link</span>
          <input
            name="callToActionHref"
            required
            type="url"
            placeholder="https://…"
            value={ctaHref}
            onChange={(event) => setCtaHref(event.target.value)}
          />
        </label>
      </div>
      <ComposerActions
        busy={busy}
        saveLabel={saveLabel}
        blocked={contentInvalid}
        onCancel={onCancel}
      />
    </form>
  );
}

export function CampaignControls({
  csrfToken,
  workspaceId,
  postSources,
  initialCampaigns,
}: {
  csrfToken: string;
  workspaceId: string;
  postSources: ReadonlyArray<
    Readonly<{
      post: Pick<BlogPost, "id" | "title">;
      artifact: BlogPostArtifactFingerprint;
    }>
  >;
  initialCampaigns: ReadonlyArray<
    Readonly<{ campaign: Campaign; revision: CampaignRevision }>
  >;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [campaigns, setCampaigns] = useState<
    ReadonlyArray<Readonly<{ campaign: Campaign; revision: CampaignRevision }>>
  >(initialCampaigns);
  const [selected, setSelected] = useState<CampaignRevision | null>(null);
  // The composer opens by itself when there is nothing to list yet.
  const [writingNew, setWritingNew] = useState(initialCampaigns.length === 0);
  const [rendered, setRendered] = useState<RenderedCampaign | null>(null);
  // The revision whose email is being previewed, so the preview can draw its
  // header and inline photos through the same-origin media route.
  const [previewRevision, setPreviewRevision] =
    useState<CampaignRevision | null>(null);
  const media: EditorMediaContext = { csrfToken, workspaceId };

  async function loadCampaigns(selectedCampaignId?: string) {
    const response = await fetch("/api/foundry-cms/campaigns", {
      cache: "no-store",
    });
    if (!response.ok) return;
    const body = (await response.json()) as {
      campaigns: ReadonlyArray<
        Readonly<{ campaign: Campaign; revision: CampaignRevision }>
      >;
    };
    setCampaigns(body.campaigns);
    if (selectedCampaignId !== undefined) {
      setSelected(
        body.campaigns.find(
          ({ campaign }) => campaign.id === selectedCampaignId,
        )?.revision ?? null,
      );
      setWritingNew(false);
    }
    return body.campaigns;
  }

  async function submit(command: unknown) {
    setBusy(true);
    try {
      const response = await fetch("/api/foundry-cms/campaigns", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `campaign:${crypto.randomUUID()}`,
          "x-foundry-csrf": csrfToken,
        },
        body: JSON.stringify(command),
      });
      setMessage(
        response.ok
          ? "Email draft saved. Nothing is sent from here."
          : "The email could not be saved. Check the fields and retry.",
      );
      if (response.ok) {
        const body = (await response.json()) as {
          campaign: Campaign;
          revision: CampaignRevision;
        };
        await loadCampaigns(body.campaign.id);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="campaigns-heading">
      <div className="dashboard-section-heading">
        <div>
          <h2 id="campaigns-heading">Emails</h2>
          <p>
            Write an email to your subscribers. It stays a private draft here;
            subscriber identities are never shown.
          </p>
        </div>
        {writingNew || selected !== null ? null : (
          <button
            type="button"
            className="button button-primary"
            disabled={busy}
            onClick={() => {
              setSelected(null);
              setWritingNew(true);
            }}
          >
            New email
          </button>
        )}
      </div>
      {writingNew ? (
        <EmailComposer
          heading="New email"
          media={media}
          busy={busy}
          saveLabel={busy ? "Saving…" : "Save email"}
          onSave={(email) => {
            void submit({
              action: "create_standalone",
              input: {
                ...email,
                emailContent: parseSerializedRichTextDocument(
                  email.emailContent,
                ),
              },
            });
          }}
          onCancel={
            campaigns.length === 0 ? undefined : () => setWritingNew(false)
          }
        />
      ) : null}
      {selected !== null ? (
        <EmailComposer
          key={`${selected.campaignId}:${selected.revisionNumber}`}
          heading="Edit email"
          initialRevision={selected}
          media={media}
          busy={busy}
          saveLabel={busy ? "Saving…" : "Save changes"}
          onSave={(email) => {
            void submit({
              action: "edit",
              campaignId: selected.campaignId,
              expectedVersion: selected.revisionNumber,
              input: {
                ...email,
                emailContent: parseSerializedRichTextDocument(
                  email.emailContent,
                ),
              },
            });
          }}
          onCancel={() => setSelected(null)}
        />
      ) : null}
      {postSources.length === 0 ? null : (
        <form
          className="campaign-from-post"
          onSubmit={(event) => {
            event.preventDefault();
            const sourcePostRevisionId = String(
              new FormData(event.currentTarget).get("sourcePostRevisionId") ??
                "",
            );
            void submit({
              action: "create_from_post",
              sourcePostRevisionId,
            });
          }}
        >
          <label>
            <span>Start from a blog post</span>
            <select name="sourcePostRevisionId" required disabled={busy}>
              {postSources.map(({ post, artifact }) => (
                <option
                  key={artifact.postRevisionId}
                  value={artifact.postRevisionId}
                >
                  {post.title}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="copy-button" disabled={busy}>
            Create email from post
          </button>
        </form>
      )}
      <ul className="post-list">
        {campaigns.map(({ campaign, revision }) => {
          // The thumbnail shown beside a campaign is its share image, falling
          // back to the header image, so a preview surface always shows a
          // picture when the campaign has one.
          const thumbnail = revision.shareImage ?? revision.headerImage ?? null;
          return (
          <li key={campaign.id}>
            <div className="post-list-summary">
              {thumbnail === null ? null : (
                <img
                  className="campaign-thumbnail"
                  src={campaignPreviewSrc(thumbnail.url)}
                  alt={thumbnail.alt}
                />
              )}
              <strong>{revision.subject}</strong>
              <span>{campaignStateLabels[campaign.lifecycleState]}</span>
            </div>
            <div className="post-list-actions">
              <button
                type="button"
                className="copy-button"
                disabled={busy}
                onClick={() => {
                  setWritingNew(false);
                  setRendered(null);
                  setPreviewRevision(null);
                  setSelected(revision);
                }}
              >
                Edit
              </button>
              <button
                type="button"
                className="copy-button"
                disabled={busy}
                onClick={() => {
                  setPreviewRevision(revision);
                  void fetch(
                    `/api/foundry-cms/campaigns?campaignId=${encodeURIComponent(
                      campaign.id,
                    )}`,
                    { cache: "no-store" },
                  )
                    .then((response) => response.json())
                    .then((body: { rendered: RenderedCampaign }) =>
                      setRendered(body.rendered),
                    )
                    .catch(() =>
                      setMessage("The preview could not be loaded. Try again."),
                    );
                }}
              >
                Preview
              </button>
            </div>
          </li>
          );
        })}
      </ul>
      {previewRevision === null ? null : (
        <section className="email-preview" aria-label="Email preview">
          <h3>How the email looks</h3>
          <div className="email-preview-message rendered-rich-text">
            {previewRevision.headerImage == null ? null : (
              <figure className="campaign-header-image">
                <img
                  src={campaignPreviewSrc(previewRevision.headerImage.url)}
                  alt={previewRevision.headerImage.alt}
                />
              </figure>
            )}
            <p className="campaign-preview-line">
              {previewRevision.previewText}
            </p>
            <RichTextRenderer
              document={previewEmailContent(previewRevision.emailContent)}
            />
            <p>
              <a href={previewRevision.callToAction.href}>
                {previewRevision.callToAction.label}
              </a>
            </p>
          </div>
          {rendered === null ? null : (
            <details>
              <summary>How the email reads, and technical details</summary>
              <pre>{rendered.text.bytes}</pre>
              <p>
                HTML fingerprint: <code>{rendered.html.fingerprint}</code>
              </p>
            </details>
          )}
        </section>
      )}
      {message === "" ? null : <p role="status">{message}</p>}
    </section>
  );
}
