import { describe, expect, it } from "vitest";

import {
  renderCampaignRevision,
  type CampaignRevision,
} from "@humber-foundry/application";
import { createSiteId } from "@humber-foundry/site-definition";

import {
  campaignPreviewContentSecurityPolicy,
  campaignPreviewDocument,
  picturesFromAnotherWebsite,
  refusalMessage,
  testFailureMessage,
  unsubscribeAddressShown,
} from "./campaign-operations";
import {
  recipientCountSentence,
  sendNowLabel,
} from "./campaign-send-review";

/**
 * One campaign revision carrying every part the renderer writes: a header
 * picture from the gallery, a body with an inline gallery picture and a link,
 * a call to action, and the compliance footer.
 */
const revision = {
  id: "30000000-0000-4000-8000-000000000001",
  siteId: createSiteId("site_reference"),
  campaignId: "20000000-0000-4000-8000-000000000001",
  revisionNumber: 1,
  provenance: { kind: "standalone" },
  subject: "September news",
  previewText: "What happened at the harbour",
  headerImage: {
    url: "https://example.org/api/media/asset_header",
    alt: "The harbour",
  },
  shareImage: null,
  callToAction: { label: "Read it", href: "https://example.org/news" },
  emailContent: {
    version: "1.0.0",
    type: "document",
    children: [
      {
        type: "paragraph",
        children: [{ type: "text", text: "Fair winds & full sails", marks: [] }],
      },
      {
        type: "image",
        src: "https://example.org/api/media/asset_inline",
        alt: "A boat",
      },
    ],
  },
  senderIdentityId: "sender-primary",
  complianceFooter: {
    version: "v1",
    content: "Example News · 1 Harbour Road · Contact: https://example.org/",
    unsubscribePlaceholder:
      "https://example.org/newsletter/stop?token={{foundry.unsubscribe.token}}",
  },
  audienceDefinition: {
    id: "canonical-consent-and-suppression",
    version: 1,
  },
  schemaVersion: "1.7.0",
  rendererVersion: "1".repeat(40),
  createdAt: "2026-09-01T00:00:00.000Z",
  createdByActorId: "membership-owner",
} as unknown as CampaignRevision;

describe("the document the email preview frame draws", () => {
  it("draws the renderer's own bytes, changing only the pictures' addresses", async () => {
    const rendered = await renderCampaignRevision(revision, 412);
    const preview = campaignPreviewDocument(rendered.html.bytes);

    // Everything the renderer wrote is still there, word for word: the
    // subject, the preview line, the body text with its escaping, the call to
    // action and the whole compliance footer.
    expect(preview).toContain("<title>September news</title>");
    expect(preview).toContain("<p>What happened at the harbour</p>");
    expect(preview).toContain("<p>Fair winds &amp; full sails</p>");
    expect(preview).toContain('<a href="https://example.org/news">Read it</a>');
    expect(preview).toContain(revision.complianceFooter.content);

    // Nothing else changed at all. Taking the two named changes back gives the
    // renderer's bytes character for character, so what the frame draws is
    // what the delivery provider sends.
    const addedToTheHead =
      `<meta http-equiv="Content-Security-Policy" content="${campaignPreviewContentSecurityPolicy}">` +
      '<base target="_blank">';
    expect(
      preview
        .replace(addedToTheHead, "")
        .replaceAll('src="/api/media/', 'src="https://example.org/api/media/'),
    ).toBe(rendered.html.bytes);
  });

  it("loads no resource from off this site", async () => {
    const rendered = await renderCampaignRevision(revision, 412);
    const preview = campaignPreviewDocument(rendered.html.bytes);

    // The policy allows one thing, a picture this site serves, and refuses
    // everything else: no script, no style sheet, no font, no other frame and
    // no tracking picture from somebody else's server.
    expect(preview).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${campaignPreviewContentSecurityPolicy}">`,
    );
    expect(campaignPreviewContentSecurityPolicy).toContain(
      "default-src 'none'",
    );
    expect(campaignPreviewContentSecurityPolicy).toContain("img-src 'self'");
    // Every picture is loaded by its same-origin path, so the frame makes no
    // request off this site even before the policy is applied.
    const loaded = Array.from(
      preview.matchAll(/<img\b[^>]*?\bsrc="([^"]*)"/giu),
      (match) => match[1]!,
    );
    expect(loaded).toEqual([
      "/api/media/asset_header",
      "/api/media/asset_inline",
    ]);
    // A press on a link opens a new browsing context, which the sandboxed
    // frame refuses, so no link in the email navigates the preview away.
    expect(preview).toContain('<base target="_blank">');
  });

  it("leaves a picture from somebody else's server as written, and counts it", () => {
    const preview = campaignPreviewDocument(
      '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
        "</head><body>" +
        '<img src="https://tracker.example.net/pixel.gif" alt="">' +
        '<img src="https://example.org/api/media/asset_header" alt="">' +
        "</body></html>",
    );

    // The policy refuses it, so the screen has to say a picture is missing
    // rather than leave a gap nobody can explain.
    expect(preview).toContain('src="https://tracker.example.net/pixel.gif"');
    expect(picturesFromAnotherWebsite(preview)).toBe(1);
  });

  it("puts the policy after the document type when an email has no head", () => {
    const preview = campaignPreviewDocument(
      "<!doctype html><body><p>Plain</p></body>",
    );

    // Anything before the document type puts the browser into quirks mode and
    // draws the email in a layout no inbox uses.
    expect(preview.startsWith("<!doctype html><meta http-equiv=")).toBe(true);
  });

  it("counts no outside picture in an email whose photos all come from this site", async () => {
    const rendered = await renderCampaignRevision(revision, 412);

    expect(
      picturesFromAnotherWebsite(campaignPreviewDocument(rendered.html.bytes)),
    ).toBe(0);
  });
});

describe("the unsubscribe address the review shows", () => {
  it("takes the one-off token marker out", () => {
    expect(
      unsubscribeAddressShown(
        revision.complianceFooter.unsubscribePlaceholder,
      ),
    ).toBe("https://example.org/newsletter/stop");
  });

  it("shows an address it cannot read back exactly as it is stored", () => {
    expect(unsubscribeAddressShown("not an address")).toBe("not an address");
  });

  it("takes the marker out whatever the parameter is called", () => {
    // The parameter's name belongs to whoever builds the address. Matching
    // the marker means renaming it there cannot leave a machine's word on
    // screen.
    expect(
      unsubscribeAddressShown(
        "https://example.org/stop?list=news&t={{foundry.unsubscribe.token}}",
      ),
    ).toBe("https://example.org/stop?list=news");
  });
});

describe("what a refused step says", () => {
  /**
   * The four refusals that guard a send. Their words are the contract between
   * the server's rules and what a person reads, so this pins them exactly. A
   * change here has to be a deliberate one.
   */
  it("keeps the words of every refusal that blocks a send", () => {
    expect(refusalMessage("bulk_test_required")).toBe(
      "Send a test first. Reason: bulk_test_required.",
    );
    expect(refusalMessage("bulk_test_stale")).toBe(
      "The email changed after that test, so the test no longer counts. " +
        "Send a new test. Reason: bulk_test_stale.",
    );
    expect(refusalMessage("bulk_test_not_reviewed")).toBe(
      "Confirm that the test arrived and looks right first. " +
        "Reason: bulk_test_not_reviewed.",
    );
    expect(refusalMessage("bulk_authorization_stale")).toBe(
      "The approval no longer matches this email. Send a new test and " +
        "approve it again. Reason: bulk_authorization_stale.",
    );
  });

  it("says in plain words why the provider did not take a test", () => {
    expect(testFailureMessage("provider_unavailable")).toBe(
      "The email provider could not be reached, so no test went out. " +
        "Reason: provider_unavailable.",
    );
    // A code nobody has written words for still reads as a sentence, with the
    // code after it, rather than as a bare identifier.
    expect(testFailureMessage("something_new")).toBe(
      "The test has not been delivered yet. Reason: something_new.",
    );
    expect(testFailureMessage("")).toBe(
      "The test has not been delivered yet.",
    );
  });
});

describe("what the review says about the list", () => {
  it("names the count in the sentence and on the confirm control", () => {
    expect(recipientCountSentence(412)).toBe("Going to 412 people.");
    expect(sendNowLabel(412)).toBe("Send to 412 people now");
  });

  it("counts one person as one person", () => {
    expect(recipientCountSentence(1)).toBe("Going to 1 person.");
    expect(sendNowLabel(1)).toBe("Send to 1 person now");
  });

  it("says plainly when nobody is on the list", () => {
    expect(recipientCountSentence(0)).toBe(
      "Nobody is on your list yet, so nobody would get it.",
    );
  });
});
