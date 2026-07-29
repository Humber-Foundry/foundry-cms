"use client";

import { useState } from "react";

import {
  renderRichTextPlain,
  type BlogPostArtifactFingerprint,
  type Campaign,
  type CampaignRevision,
  type RenderedCampaign,
} from "@foundry/application";
import {
  createRichTextDocumentFromPlainText,
  type BlogPost,
} from "@foundry/site-definition";

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
  const [campaigns, setCampaigns] = useState<
    ReadonlyArray<Readonly<{ campaign: Campaign; revision: CampaignRevision }>>
  >(initialCampaigns);
  const [selected, setSelected] = useState<CampaignRevision | null>(null);
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
    }
    return body.campaigns;
  }

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
    if (response.ok) {
      const body = (await response.json()) as {
        campaign: Campaign;
        revision: CampaignRevision;
      };
      await loadCampaigns(body.campaign.id);
    }
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
      <ul className="blog-post-operations">
        {campaigns.map(({ campaign, revision }) => (
          <li key={campaign.id}>
            <div>
              <strong>{revision.subject}</strong>
              <span>
                Revision {revision.revisionNumber} · {campaign.lifecycleState}
              </span>
            </div>
            <button type="button" onClick={() => setSelected(revision)}>
              Edit
            </button>
            <button
              type="button"
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
                  );
              }}
            >
              Render preview
            </button>
          </li>
        ))}
      </ul>
      {selected === null ? null : (
        <form
          key={selected.id}
          className="blog-post-form"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void submit({
              action: "edit",
              campaignId: selected.campaignId,
              expectedVersion: selected.revisionNumber,
              input: {
                subject: String(data.get("subject") ?? ""),
                previewText: String(data.get("previewText") ?? ""),
                callToAction: {
                  label: String(data.get("callToActionLabel") ?? ""),
                  href: String(data.get("callToActionHref") ?? ""),
                },
                emailContent: createRichTextDocumentFromPlainText(
                  String(data.get("emailContent") ?? ""),
                ),
              },
            });
          }}
        >
          <h3>Edit campaign revision</h3>
          <label>
            Subject
            <input name="subject" defaultValue={selected.subject} required />
          </label>
          <label>
            Preview text
            <textarea
              name="previewText"
              defaultValue={selected.previewText}
              required
            />
          </label>
          <label>
            Call-to-action label
            <input
              name="callToActionLabel"
              defaultValue={selected.callToAction.label}
              required
            />
          </label>
          <label>
            Call-to-action URL
            <input
              name="callToActionHref"
              defaultValue={selected.callToAction.href}
              required
            />
          </label>
          <label>
            Email content
            <textarea
              name="emailContent"
              defaultValue={renderRichTextPlain(selected.emailContent)}
              required
            />
          </label>
          <button type="submit">Save independent revision</button>
        </form>
      )}
      {rendered === null ? null : (
        <section aria-label="Rendered campaign preview">
          <h3>Plain-text preview</h3>
          <pre>{rendered.text.bytes}</pre>
          <p>
            HTML fingerprint: <code>{rendered.html.fingerprint}</code>
          </p>
        </section>
      )}
      {message === "" ? null : <p role="status">{message}</p>}
    </section>
  );
}
