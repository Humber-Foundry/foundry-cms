import {
  SAFE_RICH_TEXT_LINK_PATTERN,
  validateRichTextDocument,
  visitRichTextBlock,
  type RichTextDocument,
  type RichTextLinkMark,
  type RichTextParagraph,
  type RichTextText,
} from "@humber-foundry/site-definition";

import {
  lengthDelimitedText,
  sha256Text,
} from "./deterministic-hash";
import {
  CampaignValidationError,
  campaignAudienceDefinition,
  type CampaignAuthoringInput,
  type CampaignChannelConfiguration,
  type CampaignEditableInput,
  type CampaignRevision,
  type RenderedCampaign,
} from "./campaign-types";

function requireText(value: unknown, maximum: number): string {
  if (typeof value !== "string") throw new CampaignValidationError();
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new CampaignValidationError();
  }
  return normalized;
}

const safeLink = new RegExp(SAFE_RICH_TEXT_LINK_PATTERN, "u");

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

export function validateCampaignChannelConfiguration(
  input: CampaignChannelConfiguration,
): CampaignChannelConfiguration {
  const senderIdentityId = requireText(input.senderIdentityId, 200);
  const complianceFooter = Object.freeze({
    version: requireText(input.complianceFooter.version, 200),
    content: requireText(input.complianceFooter.content, 2_000),
    unsubscribePlaceholder: requireText(
      input.complianceFooter.unsubscribePlaceholder,
      2_000,
    ),
  });
  if (!safeLink.test(complianceFooter.unsubscribePlaceholder)) {
    throw new CampaignValidationError(
      "campaign_unsubscribe_placeholder_invalid",
    );
  }
  if (
    input.audienceDefinition.id !== campaignAudienceDefinition.id ||
    input.audienceDefinition.version !== campaignAudienceDefinition.version
  ) {
    throw new CampaignValidationError("campaign_audience_definition_invalid");
  }
  return Object.freeze({
    senderIdentityId,
    complianceFooter,
    audienceDefinition: campaignAudienceDefinition,
  });
}

export function validateCampaignInput(
  input: CampaignEditableInput,
  channelConfiguration: CampaignChannelConfiguration,
): CampaignAuthoringInput {
  try {
    if (
      typeof input.callToAction !== "object" ||
      input.callToAction === null
    ) {
      throw new CampaignValidationError();
    }
    const subject = requireText(input.subject, 200);
    const previewText = requireText(input.previewText, 1_000);
    const callToAction = Object.freeze({
      label: requireText(input.callToAction.label, 200),
      href: requireText(input.callToAction.href, 2_000),
    });
    if (!safeLink.test(callToAction.href)) {
      throw new CampaignValidationError();
    }
    const emailContent = deepFreeze(
      validateRichTextDocument(structuredClone(input.emailContent)),
    );
    return Object.freeze({
      subject,
      previewText,
      callToAction,
      emailContent,
      ...channelConfiguration,
    });
  } catch (error) {
    if (error instanceof CampaignValidationError) throw error;
    throw new CampaignValidationError();
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderTextNode(node: RichTextText): string {
  let rendered = escapeHtml(node.text);
  if (node.marks.includes("bold")) rendered = `<strong>${rendered}</strong>`;
  if (node.marks.includes("italic")) rendered = `<em>${rendered}</em>`;
  const link = node.marks.find(
    (mark): mark is RichTextLinkMark =>
      typeof mark === "object" && mark.type === "link",
  );
  return link === undefined
    ? rendered
    : `<a href="${escapeHtml(link.href)}">${rendered}</a>`;
}

const renderInline = (children: RichTextParagraph["children"]) =>
  children.map(renderTextNode).join("");
const renderListItemInline = (
  item: Readonly<{ children: ReadonlyArray<RichTextParagraph> }>,
) => renderInline(item.children[0]!.children);

function renderRichTextHtml(document: RichTextDocument): string {
  return document.children
    .map((block) =>
      visitRichTextBlock(block, {
        paragraph: (paragraph) => `<p>${renderInline(paragraph.children)}</p>`,
        heading: (heading) =>
          `<h${heading.level}>${renderInline(heading.children)}</h${heading.level}>`,
        blockquote: (blockquote) =>
          `<blockquote>${blockquote.children
            .map((paragraph) => `<p>${renderInline(paragraph.children)}</p>`)
            .join("")}</blockquote>`,
        bulletList: (list) =>
          `<ul>${list.children
            .map((item) => `<li>${renderListItemInline(item)}</li>`)
            .join("")}</ul>`,
        orderedList: (list) =>
          `<ol>${list.children
            .map((item) => `<li>${renderListItemInline(item)}</li>`)
            .join("")}</ol>`,
      }),
    )
    .join("");
}

const renderPlainInline = (children: RichTextParagraph["children"]) =>
  children
    .map((node) => {
      const link = node.marks.find(
        (mark): mark is RichTextLinkMark =>
          typeof mark === "object" && mark.type === "link",
      );
      return link === undefined ? node.text : `${node.text} (${link.href})`;
    })
    .join("");

export function renderRichTextPlain(document: RichTextDocument): string {
  return document.children
    .map((block) =>
      visitRichTextBlock(block, {
        paragraph: (paragraph) => renderPlainInline(paragraph.children),
        heading: (heading) => renderPlainInline(heading.children),
        blockquote: (blockquote) =>
          blockquote.children
            .map((paragraph) => `> ${renderPlainInline(paragraph.children)}`)
            .join("\n>\n"),
        bulletList: (list) =>
          list.children
            .map((item) => `- ${renderPlainInline(item.children[0]!.children)}`)
            .join("\n"),
        orderedList: (list) =>
          list.children
            .map(
              (item, index) =>
                `${index + 1}. ${renderPlainInline(item.children[0]!.children)}`,
            )
            .join("\n"),
      }),
    )
    .join("\n\n");
}

function renderCampaignBytes(revision: CampaignRevision) {
  const html = [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${escapeHtml(revision.subject)}</title></head><body>`,
    `<p>${escapeHtml(revision.previewText)}</p>`,
    renderRichTextHtml(revision.emailContent),
    `<p><a href="${escapeHtml(revision.callToAction.href)}">${escapeHtml(
      revision.callToAction.label,
    )}</a></p>`,
    `<footer>${escapeHtml(revision.complianceFooter.content)} · ` +
      `<a href="${escapeHtml(
        revision.complianceFooter.unsubscribePlaceholder,
      )}">Unsubscribe</a></footer>`,
    "</body></html>",
  ].join("");
  const text = [
    revision.subject,
    "",
    revision.previewText,
    "",
    renderRichTextPlain(revision.emailContent),
    "",
    `${revision.callToAction.label}: ${revision.callToAction.href}`,
    "",
    revision.complianceFooter.content,
    `Unsubscribe: ${revision.complianceFooter.unsubscribePlaceholder}`,
    "",
  ].join("\n");
  return { html, text };
}

export async function renderCampaignRevision(
  revision: CampaignRevision,
  eligibleSubscriberCount: number,
): Promise<RenderedCampaign> {
  const bytes = renderCampaignBytes(revision);
  const htmlFingerprint = await sha256Text(
    lengthDelimitedText([
      "foundry.campaign-artifact.v1",
      revision.campaignId,
      revision.id,
      "html",
      revision.schemaVersion,
      revision.rendererVersion,
      bytes.html,
    ]),
  );
  const textFingerprint = await sha256Text(
    lengthDelimitedText([
      "foundry.campaign-artifact.v1",
      revision.campaignId,
      revision.id,
      "text",
      revision.schemaVersion,
      revision.rendererVersion,
      bytes.text,
    ]),
  );
  const htmlBytesHash = await sha256Text(bytes.html);
  const textBytesHash = await sha256Text(bytes.text);
  const campaignFingerprint = await sha256Text(
    lengthDelimitedText([
      "foundry.campaign-send.v1",
      revision.campaignId,
      revision.id,
      revision.subject,
      revision.previewText,
      htmlBytesHash,
      textBytesHash,
      revision.senderIdentityId,
      revision.complianceFooter.version,
      revision.audienceDefinition.id,
      String(revision.audienceDefinition.version),
      revision.schemaVersion,
      revision.rendererVersion,
    ]),
  );
  return Object.freeze({
    campaignId: revision.campaignId,
    campaignRevisionId: revision.id,
    revisionNumber: revision.revisionNumber,
    html: Object.freeze({
      channel: "html",
      bytes: bytes.html,
      fingerprint: htmlFingerprint,
      schemaVersion: revision.schemaVersion,
      rendererVersion: revision.rendererVersion,
    }),
    text: Object.freeze({
      channel: "text",
      bytes: bytes.text,
      fingerprint: textFingerprint,
      schemaVersion: revision.schemaVersion,
      rendererVersion: revision.rendererVersion,
    }),
    campaignFingerprint,
    eligibleSubscriberCount,
  });
}
