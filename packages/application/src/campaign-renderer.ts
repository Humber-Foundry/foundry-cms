import {
  SAFE_RICH_TEXT_LINK_PATTERN,
  absoluteSiteUrl,
  campaignShareImageUrlPattern,
  mediaAssetIdFromPublishedPath,
  publishedMediaPath,
  seoShareImageUrlMaxLength,
  validateRichTextDocument,
  visitRichTextBlock,
  type RichTextBlock,
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

const campaignImagePattern = new RegExp(campaignShareImageUrlPattern, "u");

/**
 * Make one campaign image address absolute, or return null if it cannot be sent.
 *
 * An email is read outside the site, so every image in it must be an absolute
 * `https://` address; a path such as `/api/media/asset_hero` would resolve
 * against the reader's mail host and break. There are exactly two accepted
 * forms, matching ADR-0014: a `/api/media/<assetId>` reference the shared picker
 * stores, made absolute against the site's canonical origin so one picker fills
 * the campaign the same way it fills a page or a post; and an absolute `https://`
 * address, kept as written. Any other value — a bare path, an `http` address, a
 * media reference with no canonical origin to resolve it against, or one too
 * long — is refused, because it cannot be sent.
 */
function absoluteCampaignImageAddress(
  url: string,
  siteCanonicalOrigin: string,
): string | null {
  const assetId = mediaAssetIdFromPublishedPath(url);
  const absolute =
    assetId === null
      ? url
      : absoluteSiteUrl(siteCanonicalOrigin, publishedMediaPath(assetId));
  if (
    absolute === null ||
    !campaignImagePattern.test(absolute) ||
    absolute.length > seoShareImageUrlMaxLength
  ) {
    return null;
  }
  return absolute;
}

/**
 * Validate one campaign header or share image. Both carry the address-and-alt
 * shape a page and a post use; the address is made absolute here.
 */
function validateCampaignImage(
  value: CampaignEditableInput["shareImage"],
  siteCanonicalOrigin: string,
): CampaignEditableInput["shareImage"] {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "object" || typeof value.url !== "string") {
    throw new CampaignValidationError("campaign_image_invalid");
  }
  const trimmed = value.url.trim();
  if (trimmed === "") {
    return null;
  }
  const url = absoluteCampaignImageAddress(trimmed, siteCanonicalOrigin);
  if (url === null) {
    throw new CampaignValidationError("campaign_image_invalid");
  }
  const alt = typeof value.alt === "string" ? value.alt.trim() : "";
  if (alt.length > 300) {
    throw new CampaignValidationError("campaign_image_invalid");
  }
  return Object.freeze({ url, alt });
}

/**
 * Make every inline body image absolute, refusing any that cannot be sent. The
 * rich-text validator has already accepted each `src` as a root-relative path
 * or an `https://` address; the same two-form rule as the header and share
 * images applies, so a `/api/media/<assetId>` reference is made absolute and any
 * other path is refused.
 */
function absoluteEmailContentImages(
  document: RichTextDocument,
  siteCanonicalOrigin: string,
): RichTextDocument {
  const children = document.children.map((block): RichTextBlock => {
    if (block.type !== "image") {
      return block;
    }
    const src = absoluteCampaignImageAddress(block.src, siteCanonicalOrigin);
    if (src === null) {
      throw new CampaignValidationError("campaign_image_invalid");
    }
    return { ...block, src };
  });
  return { ...document, children };
}

/**
 * Carry a post's share image onto a campaign derived from that post.
 *
 * A post may name its share image by a path on the site. An email cannot
 * resolve a path, so the site's own address makes it absolute here. Without
 * that address the image is dropped, because a path in an email is a broken
 * picture in every inbox.
 */
export function campaignShareImageFromPost(
  postShareImage: CampaignEditableInput["shareImage"],
  siteCanonicalOrigin: string,
): CampaignEditableInput["shareImage"] {
  if (postShareImage === null) {
    return null;
  }
  const url = postShareImage.url.trim();
  if (url.startsWith("https://")) {
    return { url, alt: postShareImage.alt };
  }
  if (!url.startsWith("/")) {
    return null;
  }
  const absolute = absoluteSiteUrl(siteCanonicalOrigin, url as `/${string}`);
  return absolute === null ? null : { url: absolute, alt: postShareImage.alt };
}

export function validateCampaignInput(
  input: CampaignEditableInput,
  channelConfiguration: CampaignChannelConfiguration,
  siteCanonicalOrigin = "",
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
    const headerImage = validateCampaignImage(
      input.headerImage,
      siteCanonicalOrigin,
    );
    const shareImage = validateCampaignImage(
      input.shareImage,
      siteCanonicalOrigin,
    );
    const callToAction = Object.freeze({
      label: requireText(input.callToAction.label, 200),
      href: requireText(input.callToAction.href, 2_000),
    });
    if (!safeLink.test(callToAction.href)) {
      throw new CampaignValidationError();
    }
    const emailContent = deepFreeze(
      absoluteEmailContentImages(
        validateRichTextDocument(structuredClone(input.emailContent)),
        siteCanonicalOrigin,
      ),
    );
    return Object.freeze({
      subject,
      previewText,
      headerImage,
      shareImage,
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
        // A body image reaches the email as an <img>. A source that is a path
        // on the site cannot be resolved by a mail client, the same limit
        // ADR-0008 records for a path share image; inline images in a campaign
        // body are otherwise out of this change's scope.
        image: (image) =>
          `<img src="${escapeHtml(image.src)}" alt="${escapeHtml(image.alt)}" />`,
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
        image: (image) =>
          image.alt === "" ? image.src : `${image.alt} (${image.src})`,
      }),
    )
    .join("\n\n");
}

function renderCampaignBytes(revision: CampaignRevision) {
  // The header image is the picture at the top of the email. A revision stored
  // before campaign images existed has no such field, so it reads as
  // `undefined` rather than `null`. Treat both as "no image".
  const headerImage = revision.headerImage ?? null;
  const html = [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${escapeHtml(revision.subject)}</title>`,
    // No Open Graph tag here. These bytes are only ever sent to the delivery
    // provider as the message body, and a mail client drops the head. The
    // header image reaches the reader as the picture below.
    "</head><body>",
    // The preview line stays the first thing in the body. An inbox builds its
    // preview from the first text it finds, so nothing may come before it.
    `<p>${escapeHtml(revision.previewText)}</p>`,
    headerImage === null
      ? ""
      : `<img src="${escapeHtml(headerImage.url)}" alt="${escapeHtml(
          headerImage.alt,
        )}">`,
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
