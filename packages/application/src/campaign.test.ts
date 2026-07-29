import { describe, expect, it } from "vitest";

import {
  createBlogPostId,
  createRichTextDocumentFromPlainText,
  createSiteId,
  type BlogPost,
} from "@foundry/site-definition";

import {
  AccessDeniedError,
  createHumanMembershipId,
  createHumanUserId,
  type ExternalHumanIdentity,
  type HumanCapability,
  type HumanMembership,
} from "./human-access";
import {
  CampaignConflictError,
  CampaignNotFoundError,
  createCampaignApplication,
  createCampaignId,
  createCampaignRevisionId,
  type CampaignAuthoringInput,
} from "./campaign";
import { createInMemoryCampaignStore } from "./in-memory-campaign-store";
import {
  createInMemorySubscriberLedgerStore,
  createSubscriberLedgerApplication,
} from "./index";
import {
  createSubscriberLedgerAudienceResolver,
  type ConsentEvidence,
} from "./subscriber-ledger";

const siteId = createSiteId("site_reference");
const otherSiteId = createSiteId("site_other");
const editor: ExternalHumanIdentity = {
  binding: { issuer: "https://access.example", subject: "editor" },
  email: "editor@example.com",
  nonce: "editor-nonce",
};
const owner: ExternalHumanIdentity = {
  binding: { issuer: "https://access.example", subject: "owner" },
  email: "owner@example.com",
  nonce: "owner-nonce",
};
const editorMembership: HumanMembership = {
  id: createHumanMembershipId("membership-editor"),
  siteId,
  userId: createHumanUserId("user-editor"),
  email: editor.email,
  identityBinding: editor.binding,
  role: "editor",
  status: "active",
};
const ownerMembership: HumanMembership = {
  ...editorMembership,
  id: createHumanMembershipId("membership-owner"),
  userId: createHumanUserId("user-owner"),
  email: owner.email,
  identityBinding: owner.binding,
  role: "owner",
};
const sourcePostRevisionId =
  "10000000-0000-8000-8000-000000000001";
const sourcePost: BlogPost = {
  id: createBlogPostId("00000000-0000-4000-8000-000000000009"),
  revision: 3,
  collectionState: "active",
  targetVisibility: "public",
  slug: "independent-campaigns",
  title: "Independent campaigns",
  excerpt: "A copied introduction.",
  seo: {
    title: "Independent campaigns | Foundry",
    description: "A copied introduction.",
  },
  body: createRichTextDocumentFromPlainText("The copied post body."),
};
const standaloneInput: CampaignAuthoringInput = {
  subject: "A standalone campaign",
  introduction: "An introduction with <unsafe> punctuation & symbols.",
  callToAction: {
    label: "Read the update",
    href: "https://example.com/update?from=email&kind=campaign",
  },
  emailContent: createRichTextDocumentFromPlainText("Standalone email body."),
  senderIdentityId: "sender_primary",
  complianceFooterVersion: "footer-v1",
  audienceDefinition: {
    id: "canonical-consent-and-suppression",
    version: 1,
  },
};

function createFixture() {
  let id = 0;
  const store = createInMemoryCampaignStore();
  const requestedCapabilities: HumanCapability[] = [];
  const application = createCampaignApplication({
    siteId,
    store,
    authorize: async (actor, capability) => {
      requestedCapabilities.push(capability);
      if (actor.binding.subject !== editor.binding.subject) {
        throw new AccessDeniedError("capability_not_authorized");
      }
      return editorMembership;
    },
    findPostRevision: async (requestedSiteId, revisionId) =>
      requestedSiteId === siteId && revisionId === sourcePostRevisionId
        ? sourcePost
        : null,
    resolveAudience: async () => ({ eligibleSubscriberCount: 2 }),
    rendererVersion: "campaign-renderer-v1",
    schemaVersion: "1.3.0",
    clock: () => new Date("2026-07-29T07:00:00.000Z"),
    createId: (kind) =>
      kind === "campaign"
        ? "20000000-0000-4000-8000-000000000001"
        : `30000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
  });
  return { application, requestedCapabilities, store };
}

describe("campaign authoring and rendering", () => {
  it("creates a stable standalone campaign with an immutable first revision", async () => {
    const { application, requestedCapabilities } = createFixture();

    const created = await application.commands.createStandalone({
      actor: editor,
      input: standaloneInput,
    });

    expect(created.campaign).toMatchObject({
      id: createCampaignId("20000000-0000-4000-8000-000000000001"),
      siteId,
      lifecycleState: "draft",
      version: 1,
    });
    expect(created.revision).toMatchObject({
      id: createCampaignRevisionId(
        "30000000-0000-4000-8000-000000000001",
      ),
      campaignId: created.campaign.id,
      revisionNumber: 1,
      provenance: { kind: "standalone" },
      subject: standaloneInput.subject,
    });
    expect(Object.isFrozen(created.campaign)).toBe(true);
    expect(Object.isFrozen(created.revision)).toBe(true);
    expect(requestedCapabilities).toEqual(["content.write"]);
  });

  it("copies an exact post revision once and preserves provenance after later edits", async () => {
    const { application } = createFixture();

    const created = await application.commands.createFromPost({
      actor: editor,
      sourcePostRevisionId,
      senderIdentityId: "sender_primary",
      complianceFooterVersion: "footer-v1",
      audienceDefinition: standaloneInput.audienceDefinition,
    });
    const edited = await application.commands.edit({
      actor: editor,
      campaignId: created.campaign.id,
      expectedVersion: 1,
      input: {
        ...standaloneInput,
        subject: "Independent subject after derivation",
        introduction: "Independent introduction after derivation",
        callToAction: {
          label: "Independent CTA",
          href: "https://example.com/independent",
        },
        emailContent:
          createRichTextDocumentFromPlainText("Independent email body."),
      },
    });
    expect(created.revision.emailContent).not.toBe(sourcePost.body);
    expect(Object.isFrozen(created.revision.emailContent)).toBe(true);

    expect(created.revision).toMatchObject({
      subject: sourcePost.title,
      introduction: sourcePost.excerpt,
      callToAction: {
        label: "Read more",
        href: "/blog/independent-campaigns",
      },
      emailContent: sourcePost.body,
      provenance: {
        kind: "post_revision",
        postId: sourcePost.id,
        postRevisionId: sourcePostRevisionId,
        postRevisionNumber: 3,
      },
    });
    expect(edited.revision).toMatchObject({
      revisionNumber: 2,
      provenance: created.revision.provenance,
      subject: "Independent subject after derivation",
      introduction: "Independent introduction after derivation",
    });
    expect(
      await application.queries.getRevision({
        actor: editor,
        campaignId: created.campaign.id,
        revisionNumber: 1,
      }),
    ).toEqual(created.revision);
  });

  it("fails closed for stale edits and cross-site or missing source identifiers", async () => {
    const { application } = createFixture();
    const created = await application.commands.createStandalone({
      actor: editor,
      input: standaloneInput,
    });

    await expect(
      application.commands.edit({
        actor: editor,
        campaignId: created.campaign.id,
        expectedVersion: 0,
        input: standaloneInput,
      }),
    ).rejects.toBeInstanceOf(CampaignConflictError);
    await expect(
      application.queries.getCampaign({
        actor: editor,
        campaignId: createCampaignId(
          "20000000-0000-4000-8000-000000000099",
        ),
      }),
    ).rejects.toBeInstanceOf(CampaignNotFoundError);

    const otherSiteApplication = createCampaignApplication({
      siteId: otherSiteId,
      store: createInMemoryCampaignStore(),
      authorize: async () => ({ ...editorMembership, siteId: otherSiteId }),
      findPostRevision: async () => null,
      resolveAudience: async () => ({ eligibleSubscriberCount: 0 }),
      rendererVersion: "campaign-renderer-v1",
      schemaVersion: "1.3.0",
    });
    await expect(
      otherSiteApplication.commands.createFromPost({
        actor: editor,
        sourcePostRevisionId,
        senderIdentityId: "sender_primary",
        complianceFooterVersion: "footer-v1",
        audienceDefinition: standaloneInput.audienceDefinition,
      }),
    ).rejects.toBeInstanceOf(CampaignNotFoundError);
  });

  it("renders deterministic escaped HTML and plain text with independent fingerprints", async () => {
    const { application } = createFixture();
    const created = await application.commands.createStandalone({
      actor: editor,
      input: standaloneInput,
    });

    const first = await application.queries.render({
      actor: editor,
      campaignId: created.campaign.id,
    });
    const second = await application.queries.render({
      actor: editor,
      campaignId: created.campaign.id,
    });

    expect(second).toEqual(first);
    expect(first.html.bytes).toContain(
      "An introduction with &lt;unsafe&gt; punctuation &amp; symbols.",
    );
    expect(first.html.bytes).toContain(
      'href="https://example.com/update?from=email&amp;kind=campaign"',
    );
    expect(first.text.bytes).toBe(
      [
        "A standalone campaign",
        "",
        "An introduction with <unsafe> punctuation & symbols.",
        "",
        "Standalone email body.",
        "",
        "Read the update: https://example.com/update?from=email&kind=campaign",
        "",
        "footer-v1",
        "",
      ].join("\n"),
    );
    expect(first.html.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.text.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.html.fingerprint).not.toBe(first.text.fingerprint);
    expect(first.campaignFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.eligibleSubscriberCount).toBe(2);
    expect(JSON.stringify(first)).not.toContain("@");
  });

  it("resolves the canonical audience without exposing identities to an Editor", async () => {
    const ledgerStore = createInMemorySubscriberLedgerStore();
    let nextId = 0;
    const consent: ConsentEvidence = {
      lawfulBasis: "express",
      source: "public_form",
      occurredAt: "2026-07-29T06:00:00.000Z",
      disclosureVersion: "newsletter-v1",
      collectionSurface: "/newsletter",
      evidenceReference: "submission-1",
    };
    const ledger = createSubscriberLedgerApplication({
      siteId,
      store: ledgerStore,
      authorize: async (actor, capability) => {
        if (
          actor.binding.subject !== owner.binding.subject ||
          !["subscribers.manage", "subscriber-identities.read"].includes(
            capability,
          )
        ) {
          throw new AccessDeniedError("capability_not_authorized");
        }
        return ownerMembership;
      },
      identityKeySecret: "test-subscriber-identity-secret-value",
      createId: (kind) => `${kind}-${++nextId}`,
    });
    await ledger.commands.recordConsent({
      actor: owner,
      email: "eligible@example.com",
      evidence: consent,
    });
    await ledger.commands.recordConsent({
      actor: owner,
      email: "suppressed@example.com",
      evidence: { ...consent, evidenceReference: "submission-2" },
    });
    await ledger.commands.suppress({
      actor: owner,
      email: "suppressed@example.com",
      reason: "unsubscribed",
      occurredAt: "2026-07-29T06:30:00.000Z",
    });
    const resolver = createSubscriberLedgerAudienceResolver({
      siteId,
      store: ledgerStore,
    });

    await expect(
      ledger.queries.listIdentities({ actor: editor }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      resolver({
        id: "canonical-consent-and-suppression",
        version: 1,
      }),
    ).resolves.toEqual({ eligibleSubscriberCount: 1 });
  });
});
