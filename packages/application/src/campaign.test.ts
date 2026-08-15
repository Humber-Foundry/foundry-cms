import { describe, expect, it } from "vitest";

import {
  createBlogPostId,
  createRichTextDocumentFromPlainText,
  createSiteId,
  type BlogPost,
} from "@humber-foundry/site-definition";

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
  CampaignIdempotencyError,
  CampaignNotFoundError,
  createCampaignApplication,
  createCampaignId,
  createCampaignRevisionId,
  renderCampaignRevision,
  type CampaignEditableInput,
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
    keywords: [],
    shareImage: null
  },
  body: createRichTextDocumentFromPlainText("The copied post body."),
};
const standaloneInput: CampaignEditableInput = {
  subject: "A standalone campaign",
  previewText: "An introduction with <unsafe> punctuation & symbols.",
  shareImage: null,
  callToAction: {
    label: "Read the update",
    href: "https://example.com/update?from=email&kind=campaign",
  },
  emailContent: createRichTextDocumentFromPlainText("Standalone email body."),
};
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

function createFixture() {
  let id = 0;
  let campaignId = 0;
  const store = createInMemoryCampaignStore();
  const requestedCapabilities: string[] = [];
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
    identifyActor: (actor) =>
      actor.binding.subject === owner.binding.subject
        ? ownerMembership.id
        : editorMembership.id,
    findPostRevision: async (requestedSiteId, revisionId) =>
      requestedSiteId === siteId && revisionId === sourcePostRevisionId
        ? sourcePost
        : null,
    resolveAudience: async () => ({ eligibleSubscriberCount: 2 }),
    channelConfiguration,
    rendererVersion: "1111111111111111111111111111111111111111",
    schemaVersion: "1.4.0",
    clock: () => new Date("2026-07-29T07:00:00.000Z"),
    createId: (kind) =>
      kind === "campaign"
        ? `20000000-0000-4000-8000-${String(++campaignId).padStart(
            12,
            "0",
          )}`
        : `30000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
  });
  return { application, requestedCapabilities, store };
}

describe("campaign authoring and rendering", () => {
  it("creates a stable standalone campaign with an immutable first revision", async () => {
    const { application, requestedCapabilities } = createFixture();

    const created = await application.commands.createStandalone({
      actor: editor,
      requestId: "campaign-create-standalone-1",
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
    expect(requestedCapabilities).toEqual(["campaign.author"]);
  });

  it("replays one durable request result and rejects changed input under the same key", async () => {
    const { application, store } = createFixture();
    const first = await application.commands.createStandalone({
      actor: editor,
      requestId: "campaign-create-idempotent-1",
      input: standaloneInput,
    });
    const replay = await application.commands.createStandalone({
      actor: editor,
      requestId: "campaign-create-idempotent-1",
      input: standaloneInput,
    });

    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ ...first, replayed: true });
    await expect(
      application.commands.createStandalone({
        actor: editor,
        requestId: "campaign-create-idempotent-1",
        input: { ...standaloneInput, subject: "Changed input" },
      }),
    ).rejects.toBeInstanceOf(CampaignIdempotencyError);
    expect(store.listAuditEvents()).toMatchObject([
      { outcome: "accepted", action: "campaign.create" },
      {
        outcome: "rejected",
        action: "campaign.create",
        reason: "campaign_idempotency_key_reused",
        inputHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    ]);
  });

  it("rejects and audits a missing durable request key at the shared command seam", async () => {
    const { application, store } = createFixture();

    await expect(
      application.commands.createStandalone({
        actor: editor,
        requestId: "",
        input: standaloneInput,
      }),
    ).rejects.toMatchObject({
      code: "campaign_idempotency_key_invalid",
    });
    expect(store.listAuditEvents()).toMatchObject([
      {
        actorId: editorMembership.id,
        requestId: "campaign:missing",
        action: "campaign.create",
        outcome: "rejected",
        reason: "campaign_idempotency_key_invalid",
      },
    ]);
  });

  it("validates the shared request envelope before persisting a malformed-command rejection", async () => {
    const { application, store } = createFixture();

    await expect(
      application.commands.recordRejectedCommand({
        actor: editor,
        requestId: "",
        reason: "campaign_command_invalid",
        command: { action: "unknown" },
      }),
    ).rejects.toMatchObject({
      code: "campaign_idempotency_key_invalid",
    });
    expect(store.listAuditEvents()).toMatchObject([
      {
        actorId: editorMembership.id,
        requestId: "campaign:missing",
        inputHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        outcome: "rejected",
        reason: "campaign_idempotency_key_invalid",
      },
    ]);
  });

  it("durably audits and replays an authenticated actor's authorization rejection", async () => {
    const { application, store } = createFixture();
    const denied = () =>
      application.commands.createStandalone({
        actor: owner,
        requestId: "campaign-create-denied-1",
        input: standaloneInput,
      });

    await expect(denied()).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(denied()).rejects.toBeInstanceOf(AccessDeniedError);
    expect(store.listAuditEvents()).toMatchObject([
      {
        actorId: ownerMembership.id,
        requestId: "campaign-create-denied-1",
        inputHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        outcome: "rejected",
        reason: "capability_not_authorized",
      },
    ]);
  });

  it("attributes a rejected test command authorization to the requested campaign", async () => {
    const { application, store } = createFixture();
    const campaignId = createCampaignId(
      "20000000-0000-4000-8000-000000000001",
    );

    await expect(
      application.commands.recordRejectedCommand({
        actor: owner,
        requestId: "campaign-test-denied-1",
        reason: "capability_not_authorized",
        command: {
          action: "request_test",
          campaignId,
          testRecipientIds: ["owner-primary"],
        },
        targetId: campaignId,
        beforeState: JSON.stringify({
          current: { authorization: "denied" },
          required: { capability: "campaign.author" },
        }),
        action: "campaign.test",
        commandName: "campaign.request_test",
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);

    expect(store.listAuditEvents()).toMatchObject([
      {
        actorId: ownerMembership.id,
        targetId: campaignId,
        requestId: "campaign-test-denied-1",
        action: "campaign.test",
        outcome: "rejected",
        reason: "capability_not_authorized",
        beforeState: JSON.stringify({
          current: { authorization: "denied" },
          required: { capability: "campaign.author" },
        }),
      },
    ]);
  });

  it("replays terminal stale-write rejections without contradictory accepted audit", async () => {
    const { application, store } = createFixture();
    const created = await application.commands.createStandalone({
      actor: editor,
      requestId: "campaign-create-before-stale-1",
      input: standaloneInput,
    });
    const staleEdit = () =>
      application.commands.edit({
        actor: editor,
        requestId: "campaign-edit-stale-idempotent-1",
        campaignId: created.campaign.id,
        expectedVersion: 0,
        input: standaloneInput,
      });

    await expect(staleEdit()).rejects.toBeInstanceOf(CampaignConflictError);
    await expect(staleEdit()).rejects.toBeInstanceOf(CampaignConflictError);
    expect(store.listAuditEvents()).toMatchObject([
      { outcome: "accepted", action: "campaign.create" },
      {
        outcome: "rejected",
        action: "campaign.edit",
        reason: "campaign_revision_conflict",
      },
    ]);
  });

  it("copies an exact post revision once and preserves provenance after later edits", async () => {
    const { application } = createFixture();

    const created = await application.commands.createFromPost({
      actor: editor,
      requestId: "campaign-create-from-post-1",
      sourcePostRevisionId,
    });
    const edited = await application.commands.edit({
      actor: editor,
      requestId: "campaign-edit-derived-1",
      campaignId: created.campaign.id,
      expectedVersion: 1,
      input: {
        ...standaloneInput,
        subject: "Independent subject after derivation",
        previewText: "Independent introduction after derivation",
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
      previewText: sourcePost.excerpt,
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
      previewText: "Independent introduction after derivation",
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
      requestId: "campaign-create-conflict-1",
      input: standaloneInput,
    });

    await expect(
      application.commands.edit({
        actor: editor,
        requestId: "campaign-edit-conflict-1",
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
      identifyActor: () => editorMembership.id,
      findPostRevision: async () => null,
      resolveAudience: async () => ({ eligibleSubscriberCount: 0 }),
      channelConfiguration,
      rendererVersion: "1111111111111111111111111111111111111111",
      schemaVersion: "1.4.0",
    });
    await expect(
      otherSiteApplication.commands.createFromPost({
        actor: editor,
        requestId: "campaign-create-other-site-1",
        sourcePostRevisionId,
      }),
    ).rejects.toBeInstanceOf(CampaignNotFoundError);
  });

  it("renders deterministic escaped HTML and plain text with independent fingerprints", async () => {
    const { application } = createFixture();
    const created = await application.commands.createStandalone({
      actor: editor,
      requestId: "campaign-create-render-1",
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
        "You are receiving this update from Foundry.",
        "Unsubscribe: https://example.test/newsletter/unsubscribe?token={{foundry.unsubscribe.token}}",
        "",
      ].join("\n"),
    );
    expect(first.html.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.text.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.html.fingerprint).not.toBe(first.text.fingerprint);
    expect(first.campaignFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.eligibleSubscriberCount).toBe(2);
    expect(JSON.stringify(first)).not.toContain("@");
    const differentRenderer = await renderCampaignRevision(
      {
        ...created.revision,
        rendererVersion: "2222222222222222222222222222222222222222",
      },
      2,
    );
    expect(differentRenderer.html.bytes).toBe(first.html.bytes);
    expect(differentRenderer.html.fingerprint).not.toBe(
      first.html.fingerprint,
    );
  });

  it("rejects revisions bound to a renderer other than the active renderer", async () => {
    const { application, store } = createFixture();
    const created = await application.commands.createStandalone({
      actor: editor,
      requestId: "campaign-create-renderer-binding-1",
      input: standaloneInput,
    });
    const applicationAfterDeploy = createCampaignApplication({
      siteId,
      store,
      authorize: async () => editorMembership,
      identifyActor: () => editorMembership.id,
      findPostRevision: async () => null,
      resolveAudience: async () => ({ eligibleSubscriberCount: 2 }),
      channelConfiguration,
      rendererVersion: "2222222222222222222222222222222222222222",
      schemaVersion: "1.4.0",
    });

    await expect(
      applicationAfterDeploy.queries.render({
        actor: editor,
        campaignId: created.campaign.id,
      }),
    ).rejects.toMatchObject({ message: "campaign_renderer_mismatch" });
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

  it("links accepted revisions and rejected commands in the audit history", async () => {
    const { application, store } = createFixture();
    const created = await application.commands.createStandalone({
      actor: editor,
      requestId: "campaign-create-audit-1",
      input: standaloneInput,
    });
    await expect(
      application.commands.createStandalone({
        actor: editor,
        requestId: "campaign-create-invalid-1",
        input: { ...standaloneInput, subject: "" },
      }),
    ).rejects.toMatchObject({ message: "campaign_schema_invalid" });

    expect(store.listAuditEvents()).toMatchObject([
      {
        action: "campaign.create",
        outcome: "accepted",
        actorId: editorMembership.id,
        requestId: "campaign-create-audit-1",
        revisionId: created.revision.id,
      },
      {
        action: "campaign.create",
        outcome: "rejected",
        actorId: editorMembership.id,
        requestId: "campaign-create-invalid-1",
        revisionId: null,
        reason: "campaign_schema_invalid",
      },
    ]);
  });
});
