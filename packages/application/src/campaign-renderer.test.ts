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
    headerImage: null,
    shareImage: null,
    callToAction: {
      label: "Read the update",
      href: "https://example.com/update",
    },
    emailContent: createRichTextDocumentFromPlainText("Email body."),
    ...overrides,
  };
}

function buildRevision(
  input: CampaignEditableInput,
  siteCanonicalOrigin = "",
): CampaignRevision {
  return {
    ...validateCampaignInput(input, channelConfiguration, siteCanonicalOrigin),
    id: createCampaignRevisionId("30000000-0000-4000-8000-000000000001"),
    siteId: createSiteId("site_foundry_reference"),
    campaignId: createCampaignId("20000000-0000-4000-8000-000000000001"),
    revisionNumber: 1,
    provenance: { kind: "standalone" },
    schemaVersion: "1.6.0",
    rendererVersion: "1".repeat(40),
    createdAt: "2026-08-15T00:00:00.000Z",
    createdByActorId: "membership-editor",
  };
}

describe("campaign header image", () => {
  it("renders the header image as a picture at the top of the message body", async () => {
    const rendered = await renderCampaignRevision(
      buildRevision(
        buildInput({
          headerImage: {
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
          headerImage: { url: "https://cdn.example.com/harbour.png", alt: "" },
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
          headerImage: { url: "https://cdn.example.com/harbour.png", alt: "" },
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

  it("renders no image markup when the campaign has no header image", async () => {
    const rendered = await renderCampaignRevision(buildRevision(buildInput()), 2);

    expect(rendered.html.bytes).not.toContain("og:image");
    expect(rendered.html.bytes).not.toContain("<img");
  });

  it("changes the send fingerprint when the header image changes", async () => {
    const withoutImage = await renderCampaignRevision(
      buildRevision(buildInput()),
      2,
    );
    const withImage = await renderCampaignRevision(
      buildRevision(
        buildInput({
          headerImage: { url: "https://cdn.example.com/harbour.png", alt: "" },
        }),
      ),
      2,
    );

    expect(withImage.campaignFingerprint).not.toBe(
      withoutImage.campaignFingerprint,
    );
  });

  it("makes a gallery reference absolute against the site's canonical origin", async () => {
    const rendered = await renderCampaignRevision(
      buildRevision(
        buildInput({
          headerImage: { url: "/api/media/asset_hero", alt: "The harbour" },
        }),
        "https://harbour.example",
      ),
      2,
    );

    expect(rendered.html.bytes).toContain(
      '<img src="https://harbour.example/api/media/asset_hero" alt="The harbour">',
    );
  });

  it("escapes a header image address and its alt text", async () => {
    const rendered = await renderCampaignRevision(
      buildRevision(
        buildInput({
          headerImage: {
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

  it("rejects a gallery reference when the site has no canonical origin", () => {
    expect(() =>
      validateCampaignInput(
        buildInput({
          headerImage: { url: "/api/media/asset_hero", alt: "" },
        }),
        channelConfiguration,
        "",
      ),
    ).toThrow("campaign_image_invalid");
  });

  it("rejects a header image address with an unsafe scheme", () => {
    expect(() =>
      validateCampaignInput(
        buildInput({
          headerImage: {
            url: "javascript:alert(1)",
            alt: "",
          } as CampaignEditableInput["headerImage"] & object,
        }),
        channelConfiguration,
      ),
    ).toThrow("campaign_image_invalid");
  });

  it("keeps the header image out of the plain-text channel", async () => {
    const rendered = await renderCampaignRevision(
      buildRevision(
        buildInput({
          headerImage: { url: "https://cdn.example.com/harbour.png", alt: "x" },
        }),
      ),
      2,
    );

    expect(rendered.text.bytes).not.toContain("cdn.example.com/harbour.png");
  });
});

describe("campaign share image", () => {
  it("is the thumbnail and does not render in the email body", async () => {
    const rendered = await renderCampaignRevision(
      buildRevision(
        buildInput({
          shareImage: { url: "https://cdn.example.com/thumb.png", alt: "" },
        }),
      ),
      2,
    );

    // The share image is used where the campaign is previewed or shared, not
    // inside the message. Only a header image draws a picture in the body.
    expect(rendered.html.bytes).not.toContain("<img");
    expect(rendered.html.bytes).not.toContain("cdn.example.com/thumb.png");
  });

  it("does not change the send fingerprint, because it is not sent", async () => {
    const withoutThumb = await renderCampaignRevision(
      buildRevision(buildInput()),
      2,
    );
    const withThumb = await renderCampaignRevision(
      buildRevision(
        buildInput({
          shareImage: { url: "https://cdn.example.com/thumb.png", alt: "" },
        }),
      ),
      2,
    );

    expect(withThumb.campaignFingerprint).toBe(withoutThumb.campaignFingerprint);
  });

  it("makes a gallery reference absolute against the canonical origin", () => {
    const authored = validateCampaignInput(
      buildInput({
        shareImage: { url: "/api/media/asset_card", alt: "Card" },
      }),
      channelConfiguration,
      "https://harbour.example",
    );

    expect(authored.shareImage).toEqual({
      url: "https://harbour.example/api/media/asset_card",
      alt: "Card",
    });
  });
});

describe("campaign inline body image", () => {
  it("makes a gallery reference in the body absolute for the email", async () => {
    const authored = validateCampaignInput(
      buildInput({
        emailContent: {
          version: "1.0.0",
          type: "document",
          children: [
            { type: "image", src: "/api/media/asset_body", alt: "In the body" },
          ],
        } as CampaignEditableInput["emailContent"],
      }),
      channelConfiguration,
      "https://harbour.example",
    );
    const rendered = await renderCampaignRevision(
      { ...buildRevision(buildInput()), emailContent: authored.emailContent },
      2,
    );

    expect(rendered.html.bytes).toContain(
      '<img src="https://harbour.example/api/media/asset_body" alt="In the body" />',
    );
  });

  it("keeps an https body image unchanged", () => {
    const authored = validateCampaignInput(
      buildInput({
        emailContent: {
          version: "1.0.0",
          type: "document",
          children: [
            { type: "image", src: "https://cdn.example.com/b.png", alt: "" },
          ],
        } as CampaignEditableInput["emailContent"],
      }),
      channelConfiguration,
      "https://harbour.example",
    );

    expect(authored.emailContent.children[0]).toMatchObject({
      type: "image",
      src: "https://cdn.example.com/b.png",
    });
  });

  it("rejects a body gallery reference when the site has no canonical origin", () => {
    expect(() =>
      validateCampaignInput(
        buildInput({
          emailContent: {
            version: "1.0.0",
            type: "document",
            children: [
              { type: "image", src: "/api/media/asset_body", alt: "" },
            ],
          } as CampaignEditableInput["emailContent"],
        }),
        channelConfiguration,
        "",
      ),
    ).toThrow("campaign_image_invalid");
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
