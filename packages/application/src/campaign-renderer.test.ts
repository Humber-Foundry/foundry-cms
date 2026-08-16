import { describe, expect, it } from "vitest";

import {
  createRichTextDocumentFromPlainText,
  createSiteId,
} from "@humber-foundry/site-definition";

import {
  campaignShareImageFromPost,
  renderCampaignRevision,
  validateCampaignInput,
} from "./campaign-renderer";
import {
  createCampaignId,
  createCampaignRevisionId,
  type CampaignEditableInput,
  type CampaignRevision,
} from "./campaign-types";

const channelConfiguration = {
  senderIdentityId: "sender_primary",
  complianceFooter: {
    version: "footer-v1",
    content: "You are receiving this update from Foundry.",
    unsubscribePlaceholder:
      "https://example.test/newsletter/unsubscribe" +
      "?token={{foundry.unsubscribe.token}}",
  },
  audienceDefinition: {
    id: "canonical-consent-and-suppression",
    version: 1,
  } as const,
};

function buildInput(
  overrides: Partial<CampaignEditableInput> = {},
): CampaignEditableInput {
  return {
    subject: "A harbour update",
    previewText: "What changed this month.",
    shareImage: null,
    callToAction: {
      label: "Read the update",
      href: "https://example.com/update",
    },
    emailContent: createRichTextDocumentFromPlainText("Email body."),
    ...overrides,
  };
}

function buildRevision(input: CampaignEditableInput): CampaignRevision {
  return {
    ...validateCampaignInput(input, channelConfiguration),
    id: createCampaignRevisionId("30000000-0000-4000-8000-000000000001"),
    siteId: createSiteId("site_foundry_reference"),
    campaignId: createCampaignId("20000000-0000-4000-8000-000000000001"),
    revisionNumber: 1,
    provenance: { kind: "standalone" },
    schemaVersion: "1.5.0",
    rendererVersion: "1".repeat(40),
    createdAt: "2026-08-15T00:00:00.000Z",
    createdByActorId: "membership-editor",
  };
}

describe("campaign share image", () => {
  it("renders the share image as a picture in the message body", async () => {
    const rendered = await renderCampaignRevision(
      buildRevision(
        buildInput({
          shareImage: {
            url: "https://cdn.example.com/harbour.png",
            alt: "The harbour at dawn",
          },
        }),
      ),
      2,
    );

    expect(rendered.html.bytes).toContain(
      '<img src="https://cdn.example.com/harbour.png" alt="The harbour at dawn">',
    );
  });

  it("emits no Open Graph tag, because a mail client drops the head", async () => {
    const rendered = await renderCampaignRevision(
      buildRevision(
        buildInput({
          shareImage: { url: "https://cdn.example.com/harbour.png", alt: "" },
        }),
      ),
      2,
    );

    expect(rendered.html.bytes).not.toContain("og:image");
  });

  it("keeps the preview line ahead of the picture", async () => {
    const rendered = await renderCampaignRevision(
      buildRevision(
        buildInput({
          shareImage: { url: "https://cdn.example.com/harbour.png", alt: "" },
        }),
      ),
      2,
    );

    // An inbox builds its preview from the first text in the body, so the
    // preview line must come before anything else.
    expect(rendered.html.bytes.indexOf("What changed this month.")).toBeLessThan(
      rendered.html.bytes.indexOf("<img"),
    );
  });

  it("renders no image markup when the campaign has no share image", async () => {
    const rendered = await renderCampaignRevision(buildRevision(buildInput()), 2);

    expect(rendered.html.bytes).not.toContain("og:image");
    expect(rendered.html.bytes).not.toContain("<img");
  });

  it("changes the send fingerprint when the share image changes", async () => {
    const withoutImage = await renderCampaignRevision(
      buildRevision(buildInput()),
      2,
    );
    const withImage = await renderCampaignRevision(
      buildRevision(
        buildInput({
          shareImage: { url: "https://cdn.example.com/harbour.png", alt: "" },
        }),
      ),
      2,
    );

    expect(withImage.campaignFingerprint).not.toBe(
      withoutImage.campaignFingerprint,
    );
  });

  it("escapes a share image address and its alt text", async () => {
    const rendered = await renderCampaignRevision(
      buildRevision(
        buildInput({
          shareImage: {
            url: "https://cdn.example.com/a.png?w=1&h=2",
            alt: 'A "wide" harbour',
          },
        }),
      ),
      2,
    );

    expect(rendered.html.bytes).toContain(
      "https://cdn.example.com/a.png?w=1&amp;h=2",
    );
    expect(rendered.html.bytes).toContain("A &quot;wide&quot; harbour");
  });

  it("rejects a share image address that is not absolute https", () => {
    expect(() =>
      validateCampaignInput(
        buildInput({
          shareImage: { url: "/api/media/asset_hero", alt: "" },
        }),
        channelConfiguration,
      ),
    ).toThrow("campaign_share_image_invalid");
  });

  it("rejects a share image address with an unsafe scheme", () => {
    expect(() =>
      validateCampaignInput(
        buildInput({
          shareImage: {
            url: "javascript:alert(1)",
            alt: "",
          } as CampaignEditableInput["shareImage"] & object,
        }),
        channelConfiguration,
      ),
    ).toThrow("campaign_share_image_invalid");
  });

  it("keeps the share image out of the plain-text channel", async () => {
    const rendered = await renderCampaignRevision(
      buildRevision(
        buildInput({
          shareImage: { url: "https://cdn.example.com/harbour.png", alt: "x" },
        }),
      ),
      2,
    );

    expect(rendered.text.bytes).not.toContain("cdn.example.com/harbour.png");
  });
});

describe("share image carried from a post", () => {
  it("makes a post share image path absolute using the site address", () => {
    expect(
      campaignShareImageFromPost(
        { url: "/api/media/asset_hero", alt: "The harbour" },
        "https://harbour.example",
      ),
    ).toEqual({
      url: "https://harbour.example/api/media/asset_hero",
      alt: "The harbour",
    });
  });

  it("keeps an address that is already absolute", () => {
    expect(
      campaignShareImageFromPost(
        { url: "https://cdn.example.com/card.png", alt: "" },
        "https://harbour.example",
      ),
    ).toEqual({ url: "https://cdn.example.com/card.png", alt: "" });
  });

  it("drops a path when the site has no address to make it absolute", () => {
    expect(
      campaignShareImageFromPost({ url: "/api/media/asset_hero", alt: "" }, ""),
    ).toBeNull();
  });

  it("carries nothing when the post has no share image", () => {
    expect(campaignShareImageFromPost(null, "https://harbour.example")).toBeNull();
  });
});
