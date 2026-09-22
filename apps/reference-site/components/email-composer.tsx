"use client";

import { useState } from "react";

import type { CampaignRevision } from "@humber-foundry/application";
import {
  seoFieldHints,
  serializeRichTextDocument,
  toSeoShareImage,
  type SerializedRichTextDocument,
} from "@humber-foundry/site-definition";

import { ChangePhotoField, type EditorMediaContext } from "./change-photo-field";
import { ComposerActions, emptyRichTextBody } from "./composer";
import { RichTextEditor } from "./rich-text-editor";

/** What one saved email carries back to the screen that owns the save. */
export type EmailComposerDraft = Readonly<{
  subject: string;
  previewText: string;
  headerImage: CampaignRevision["headerImage"];
  shareImage: CampaignRevision["shareImage"];
  callToAction: { label: string; href: string };
  emailContent: SerializedRichTextDocument;
}>;

/**
 * The form for one email: a subject, the email itself, and the inbox
 * details below it. Used both for a new email and for editing a saved one;
 * the key on the caller resets the fields when the saved revision changes.
 */
export function EmailComposer({
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
  onSave(email: EmailComposerDraft): void;
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
          <p className="composer-section-heading" aria-hidden="true">
            SEO and sharing — how this email looks in an inbox
          </p>
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
          <p className="composer-hint">Leave blank to use the header image.</p>
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
