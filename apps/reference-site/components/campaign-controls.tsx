"use client";

import { useState } from "react";

import {
  campaignAudienceDefinition,
  type BlogPostArtifactFingerprint,
} from "@foundry/application";
import {
  createRichTextDocumentFromPlainText,
  type BlogPost,
} from "@foundry/site-definition";

export function CampaignControls({
  csrfToken,
  postSources,
}: {
  csrfToken: string;
  postSources: ReadonlyArray<
    Readonly<{
      post: Pick<BlogPost, "id" | "title">;
      artifact: BlogPostArtifactFingerprint;
    }>
  >;
}) {
  const [message, setMessage] = useState("");

  async function submit(command: unknown) {
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
        ? "Campaign revision saved."
        : "The campaign was rejected. Check the fields and retry.",
    );
  }

  return (
    <section aria-labelledby="campaigns-heading">
      <div className="dashboard-section-heading">
        <div>
          <h2 id="campaigns-heading">Campaigns</h2>
          <p>
            Create an independent email revision without exposing subscriber
            identities.
          </p>
        </div>
      </div>
      <form
        className="blog-post-form"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const subject = String(data.get("subject") ?? "").trim();
          const previewText = String(data.get("previewText") ?? "").trim();
          const callToActionLabel = String(
            data.get("callToActionLabel") ?? "",
          ).trim();
          const callToActionHref = String(
            data.get("callToActionHref") ?? "",
          ).trim();
          const emailContent = String(data.get("emailContent") ?? "").trim();
          void submit({
            action: "create_standalone",
            input: {
              subject,
              previewText,
              callToAction: {
                label: callToActionLabel,
                href: callToActionHref,
              },
              emailContent: createRichTextDocumentFromPlainText(emailContent),
              senderIdentityId: "sender_primary",
              complianceFooter: {
                version: "reference-footer-v1",
                content:
                  "You are receiving this message from the reference installation.",
              },
              audienceDefinition: campaignAudienceDefinition,
            },
          });
        }}
      >
        <label>
          Subject
          <input name="subject" required maxLength={200} />
        </label>
        <label>
          Preview text
          <textarea name="previewText" required maxLength={1000} />
        </label>
        <label>
          Call-to-action label
          <input name="callToActionLabel" required maxLength={200} />
        </label>
        <label>
          Call-to-action URL
          <input name="callToActionHref" required type="url" />
        </label>
        <label>
          Email content
          <textarea name="emailContent" required />
        </label>
        <button type="submit">Create standalone campaign</button>
      </form>
      {postSources.length === 0 ? null : (
        <form
          className="blog-post-form"
          onSubmit={(event) => {
            event.preventDefault();
            const sourcePostRevisionId = String(
              new FormData(event.currentTarget).get("sourcePostRevisionId") ??
                "",
            );
            void submit({
              action: "create_from_post",
              sourcePostRevisionId,
              senderIdentityId: "sender_primary",
              complianceFooter: {
                version: "reference-footer-v1",
                content:
                  "You are receiving this message from the reference installation.",
              },
              audienceDefinition: campaignAudienceDefinition,
            });
          }}
        >
          <label>
            Source post revision
            <select name="sourcePostRevisionId" required>
              {postSources.map(({ post, artifact }) => (
                <option
                  key={artifact.postRevisionId}
                  value={artifact.postRevisionId}
                >
                  {post.title} · revision {artifact.revision}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">Derive campaign from post</button>
        </form>
      )}
      {message === "" ? null : <p role="status">{message}</p>}
    </section>
  );
}
