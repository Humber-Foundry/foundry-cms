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
  parseSerializedRichTextDocument,
  seoFieldHints,
  serializeRichTextDocument,
  toSeoShareImage,
  type SerializedRichTextDocument,
  type BlogPost,
} from "@humber-foundry/site-definition";

import { RichTextEditor } from "./rich-text-editor";
import { ComposerActions, emptyRichTextBody } from "./composer";

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
  busy,
  saveLabel,
  onSave,
  onCancel,
}: {
  heading: string;
  initialRevision?: CampaignRevision;
  busy: boolean;
  saveLabel: string;
  onSave(email: {
    subject: string;
    previewText: string;
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
      <RichTextEditor
        id="campaign-email-content"
        label="Email body"
        describedBy="campaign-email-content-hint"
        value={content}
        disabled={busy}
        invalid={contentInvalid}
        onChange={setContent}
        onValidationChange={setContentInvalid}
      />
      <p className="composer-hint" id="campaign-email-content-hint">
        Write the email here. Formatting and links are kept exactly as you set
        them.
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
          <label>
            <span>Share image address</span>
            <small className="composer-hint">
              {seoFieldHints.campaignShareImageUrl}
            </small>
            <input
              name="shareImageUrl"
              type="url"
              maxLength={2000}
              placeholder="https://…"
              value={shareImageUrl}
              onChange={(event) => setShareImageUrl(event.target.value)}
            />
          </label>
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
  postSources,
  initialCampaigns,
}: {
  csrfToken: string;
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
        {campaigns.map(({ campaign, revision }) => (
          <li key={campaign.id}>
            <div className="post-list-summary">
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
        ))}
      </ul>
      {rendered === null ? null : (
        <section className="email-preview" aria-label="Email preview">
          <h3>How the email reads</h3>
          <pre>{rendered.text.bytes}</pre>
          <details>
            <summary>Technical details</summary>
            <p>
              HTML fingerprint: <code>{rendered.html.fingerprint}</code>
            </p>
          </details>
        </section>
      )}
      {message === "" ? null : <p role="status">{message}</p>}
    </section>
  );
}
