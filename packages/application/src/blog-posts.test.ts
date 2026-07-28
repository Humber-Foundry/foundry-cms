import { describe, expect, it } from "vitest";
import {
  BlogPostError,
  createBlogPostActorId,
  createBlogPostApplication,
  createBlogPostId,
  createInMemoryBlogPostStore,
  createPostPublicationId,
  type BlogPostPublicationPipeline,
  type PostPublicationRequest,
} from "./blog-posts";
import { createSiteId, type RichTextDocument } from "@foundry/site-definition";

const siteId = createSiteId("site_acme");
const otherSiteId = createSiteId("site_other");
const editorId = createBlogPostActorId(
  "membership_00000000-0000-4000-8000-000000000001",
);
const ownerId = createBlogPostActorId(
  "membership_00000000-0000-4000-8000-000000000002",
);
const postId = createBlogPostId("00000000-0000-4000-8000-000000000003");

const body: RichTextDocument = {
  version: "1.0.0",
  type: "document",
  children: [
    {
      type: "paragraph",
      children: [{ type: "text", text: "Hello world.", marks: [] }],
    },
  ],
};

function metadata(title = "First post") {
  return {
    title,
    slug: "first-post",
    excerpt: "A useful introduction.",
    seoTitle: "First post | Acme",
    seoDescription: "A useful introduction to the first Acme post.",
  } as const;
}

function pipeline() {
  const requests: PostPublicationRequest[] = [];
  const adapter: BlogPostPublicationPipeline = {
    rendererVersion: "renderer-abc123",
    schemaVersion: "foundry.blog-post.v1",
    productionBase: "git:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@content:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    channelConfigurationHash:
      "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    async publish(request) {
      requests.push(request);
      return {
        publicationId: request.publicationId,
        fingerprint: request.fingerprint,
        deploymentId: `deployment-${requests.length}`,
      };
    },
    async verifyLive(receipt) {
      return {
        publicationId: receipt.publicationId,
        fingerprint: receipt.fingerprint,
        live: true,
      };
    },
  };
  return { adapter, requests };
}

function application(
  adapter: BlogPostPublicationPipeline,
  store = createInMemoryBlogPostStore(),
) {
  return createBlogPostApplication({
    siteId,
    store,
    pipeline: adapter,
    now: (() => {
      let tick = 0;
      return () => `2026-07-28T12:00:0${tick++}.000Z`;
    })(),
  });
}

async function expectCode(
  promise: Promise<unknown>,
  code: BlogPostError["code"],
) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("first-class blog posts", () => {
  it("creates a stable site-scoped post with schema-valid immutable revisions", async () => {
    const { adapter } = pipeline();
    const app = application(adapter);
    const created = await app.create({
      siteId,
      postId,
      actor: { id: editorId, role: "editor", human: true },
      metadata: metadata(),
      body,
    });

    expect(created.post.id).toBe(postId);
    expect(created.post.siteId).toBe(siteId);
    expect(created.revision.number).toBe(1);
    expect(created.revision.schemaVersion).toBe("foundry.blog-post.v1");
    expect(Object.isFrozen(created.revision)).toBe(true);
    expect(Object.isFrozen(created.revision.body)).toBe(true);

    const edited = await app.edit({
      siteId,
      postId,
      actor: { id: editorId, role: "editor", human: true },
      expectedVersion: 1,
      metadata: metadata("Revised post"),
      body,
    });
    expect(edited.post.id).toBe(postId);
    expect(edited.revision.number).toBe(2);
    expect((await app.getRevision(siteId, postId, 1))?.metadata.title).toBe(
      "First post",
    );
    expect((await app.getRevision(siteId, postId, 2))?.metadata.title).toBe(
      "Revised post",
    );
  });

  it("rejects invalid metadata and unsafe rich text before persistence", async () => {
    const { adapter } = pipeline();
    const app = application(adapter);
    await expectCode(
      app.create({
        siteId,
        postId,
        actor: { id: editorId, role: "editor", human: true },
        metadata: { ...metadata(), slug: "../escape" },
        body,
      }),
      "schema_invalid",
    );
    await expectCode(
      app.create({
        siteId,
        postId,
        actor: { id: editorId, role: "editor", human: true },
        metadata: metadata(),
        body: {
          ...body,
          children: [
            {
              type: "paragraph",
              children: [
                {
                  type: "text",
                  text: "bad",
                  marks: [{ type: "link", href: "javascript:alert(1)" }],
                },
              ],
            },
          ],
        },
      }),
      "schema_invalid",
    );
    expect(await app.get(siteId, postId)).toBeNull();
  });

  it("uses one exact fingerprint for preview, approval, publication, and live verification", async () => {
    const { adapter, requests } = pipeline();
    const app = application(adapter);
    await app.create({
      siteId,
      postId,
      actor: { id: editorId, role: "editor", human: true },
      metadata: metadata(),
      body,
    });
    const preview = await app.preview({
      siteId,
      postId,
      revisionNumber: 1,
      actor: { id: editorId, role: "editor", human: true },
    });
    const approved = await app.approve({
      siteId,
      postId,
      actor: { id: ownerId, role: "owner", human: true },
      expectedVersion: 2,
      revisionNumber: 1,
      previewFingerprint: preview.fingerprint,
    });
    const started = await app.publish({
      siteId,
      postId,
      actor: { id: editorId, role: "editor", human: true },
      expectedVersion: 3,
      approvalId: approved.approval.id,
      publicationId: createPostPublicationId(
        "00000000-0000-4000-8000-000000000004",
      ),
    });
    expect(requests[0]).toMatchObject({
      kind: "publish",
      fingerprint: preview.fingerprint,
      revisionNumber: 1,
      attributedActorId: editorId,
    });
    expect(started.publication.fingerprint).toBe(preview.fingerprint);
    expect(started.post.liveRevisionNumber).toBeNull();

    const live = await app.verifyPublication({
      siteId,
      postId,
      publicationId: started.publication.id,
      expectedVersion: 4,
    });
    expect(live.publication.status).toBe("verified-live");
    expect(live.post.liveRevisionNumber).toBe(1);
    expect(live.publication.fingerprint).toBe(preview.fingerprint);
  });

  it("fails closed for stale approval after an edit", async () => {
    const { adapter } = pipeline();
    const app = application(adapter);
    await app.create({
      siteId,
      postId,
      actor: { id: editorId, role: "editor", human: true },
      metadata: metadata(),
      body,
    });
    const preview = await app.preview({
      siteId,
      postId,
      revisionNumber: 1,
      actor: { id: editorId, role: "editor", human: true },
    });
    const approved = await app.approve({
      siteId,
      postId,
      actor: { id: editorId, role: "editor", human: true },
      expectedVersion: 2,
      revisionNumber: 1,
      previewFingerprint: preview.fingerprint,
    });
    await app.edit({
      siteId,
      postId,
      actor: { id: editorId, role: "editor", human: true },
      expectedVersion: 3,
      metadata: metadata("Changed after approval"),
      body,
    });
    await expectCode(
      app.publish({
        siteId,
        postId,
        actor: { id: editorId, role: "editor", human: true },
        expectedVersion: 4,
        approvalId: approved.approval.id,
        publicationId: createPostPublicationId(
          "00000000-0000-4000-8000-000000000004",
        ),
      }),
      "approval_stale",
    );
  });

  it("rejects concurrent edits, cross-site IDs, non-human approval, and illegal transitions", async () => {
    const { adapter } = pipeline();
    const app = application(adapter);
    await app.create({
      siteId,
      postId,
      actor: { id: editorId, role: "editor", human: true },
      metadata: metadata(),
      body,
    });
    await expectCode(
      app.edit({
        siteId,
        postId,
        actor: { id: editorId, role: "editor", human: true },
        expectedVersion: 0,
        metadata: metadata("Lost update"),
        body,
      }),
      "revision_conflict",
    );
    const concurrent = await Promise.allSettled([
      app.edit({
        siteId,
        postId,
        actor: { id: editorId, role: "editor", human: true },
        expectedVersion: 1,
        metadata: metadata("Concurrent winner A"),
        body,
      }),
      app.edit({
        siteId,
        postId,
        actor: { id: ownerId, role: "owner", human: true },
        expectedVersion: 1,
        metadata: metadata("Concurrent winner B"),
        body,
      }),
    ]);
    expect(concurrent.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(concurrent.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    await expectCode(app.get(otherSiteId, postId), "cross_site_identifier");
    const preview = await app.preview({
      siteId,
      postId,
      revisionNumber: 2,
      actor: { id: editorId, role: "editor", human: true },
    });
    await expectCode(
      app.approve({
        siteId,
        postId,
        actor: {
          id: createBlogPostActorId(
            "mcp_00000000-0000-4000-8000-000000000005",
          ),
          role: "agent",
          human: false,
        },
        expectedVersion: 3,
        revisionNumber: 2,
        previewFingerprint: preview.fingerprint,
      }),
      "human_approval_required",
    );
    await expectCode(
      app.unpublish({
        siteId,
        postId,
        actor: { id: editorId, role: "editor", human: true },
        expectedVersion: 3,
        publicationId: createPostPublicationId(
          "00000000-0000-4000-8000-000000000006",
        ),
      }),
      "post_not_live",
    );
  });

  it("invalidates a preview when the exact production channel changes", async () => {
    const { adapter } = pipeline();
    const app = application(adapter);
    await app.create({
      siteId,
      postId,
      actor: { id: editorId, role: "editor", human: true },
      metadata: metadata(),
      body,
    });
    const preview = await app.preview({
      siteId,
      postId,
      revisionNumber: 1,
      actor: { id: editorId, role: "editor", human: true },
    });
    Object.defineProperty(adapter, "channelConfigurationHash", {
      value: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    });
    await expectCode(
      app.approve({
        siteId,
        postId,
        actor: { id: editorId, role: "editor", human: true },
        expectedVersion: 2,
        revisionNumber: 1,
        previewFingerprint: preview.fingerprint,
      }),
      "preview_stale",
    );
  });

  it("unpublishes with a new attributed publication and preserves all history", async () => {
    const { adapter, requests } = pipeline();
    const app = application(adapter);
    await app.create({
      siteId,
      postId,
      actor: { id: editorId, role: "editor", human: true },
      metadata: metadata(),
      body,
    });
    const preview = await app.preview({
      siteId,
      postId,
      revisionNumber: 1,
      actor: { id: editorId, role: "editor", human: true },
    });
    const approval = await app.approve({
      siteId,
      postId,
      actor: { id: editorId, role: "editor", human: true },
      expectedVersion: 2,
      revisionNumber: 1,
      previewFingerprint: preview.fingerprint,
    });
    const published = await app.publish({
      siteId,
      postId,
      actor: { id: editorId, role: "editor", human: true },
      expectedVersion: 3,
      approvalId: approval.approval.id,
      publicationId: createPostPublicationId(
        "00000000-0000-4000-8000-000000000004",
      ),
    });
    await app.verifyPublication({
      siteId,
      postId,
      publicationId: published.publication.id,
      expectedVersion: 4,
    });
    const removal = await app.unpublish({
      siteId,
      postId,
      actor: { id: ownerId, role: "owner", human: true },
      expectedVersion: 5,
      publicationId: createPostPublicationId(
        "00000000-0000-4000-8000-000000000006",
      ),
    });
    expect(removal.publication.kind).toBe("unpublish");
    expect(requests[1]).toMatchObject({
      kind: "unpublish",
      attributedActorId: ownerId,
      revisionNumber: 1,
    });
    expect(removal.post.liveRevisionNumber).toBe(1);

    const removed = await app.verifyPublication({
      siteId,
      postId,
      publicationId: removal.publication.id,
      expectedVersion: 6,
    });
    expect(removed.post.liveRevisionNumber).toBeNull();
    expect(await app.getRevision(siteId, postId, 1)).not.toBeNull();
    expect(await app.listPublications(siteId, postId)).toHaveLength(2);
    expect((await app.listPublications(siteId, postId))[0]?.attributedActorId)
      .toBe(editorId);
    expect((await app.listPublications(siteId, postId))[1]?.attributedActorId)
      .toBe(ownerId);
  });
});
