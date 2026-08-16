import { describe, expect, it } from "vitest";

import {
  createBlogPostId,
  createRichTextDocumentFromPlainText,
  referenceSiteDefinition,
} from "@humber-foundry/site-definition";

import { createBlogPostArtifactFingerprint } from "./blog-artifacts";

describe("blog post artifact fingerprint", () => {
  it("binds the exact stable revision and rendered post inputs", async () => {
    const post = {
      id: createBlogPostId(
        "00000000-0000-4000-8000-000000000009",
      ),
      revision: 1,
      collectionState: "active" as const,
      targetVisibility: "public" as const,
      slug: "exact-pipeline",
      title: "Exact pipeline",
      excerpt: "Published through the site pipeline.",
      seo: {
        title: "Exact pipeline | Foundry",
        description: "A post using the exact site publication pipeline.",
        keywords: [],
        shareImage: null,
      },
      body: createRichTextDocumentFromPlainText("Exact post body."),
    };
    const fingerprint = await createBlogPostArtifactFingerprint({
      definition: referenceSiteDefinition,
      post,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      rendererVersion: "renderer-v1",
    });

    expect(fingerprint).toEqual({
      postId: "00000000-0000-4000-8000-000000000009",
      postRevisionId: "bc399d01-e8b8-832d-a147-a24473ccf411",
      revision: 1,
      contentHash:
        "85a9ad9072a60edb557f646b1a1e75b3ef09a03b1a9ff8b53f5f19e74bc8dce9",
      schemaVersion: "1.5.0",
      rendererVersion: "renderer-v1",
      serializationVersion: "foundry.post-artifact.v1",
      renderedBytesHash:
        "e0a676db5ddbc26dba29b13b566427d75cb48981790609176417bf6261f78d8a",
      value:
        "c8dabbf3e86db9b145408c7a642a564aaafc6fa535bab12d0f788b3c3d5ca4ec",
    });

    const changedChrome = await createBlogPostArtifactFingerprint({
      definition: {
        ...referenceSiteDefinition,
        site: {
          ...referenceSiteDefinition.site,
          footer: "Changed route chrome",
        },
      },
      post,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      rendererVersion: "renderer-v1",
    });
    expect(changedChrome).toMatchObject({
      postRevisionId: fingerprint.postRevisionId,
      contentHash: fingerprint.contentHash,
    });
    expect(changedChrome.renderedBytesHash).not.toBe(
      fingerprint.renderedBytesHash,
    );
    expect(changedChrome.value).not.toBe(fingerprint.value);

    // The SEO and sharing block decides what a search result and a link
    // preview say, so it is part of what a human approved. Changing it must
    // produce a different content hash, or an old approval could cover copy
    // the approver never saw.
    const changedShareImage = await createBlogPostArtifactFingerprint({
      definition: referenceSiteDefinition,
      post: {
        ...post,
        seo: {
          ...post.seo,
          shareImage: { url: "https://cdn.example.com/card.png", alt: "Card" },
        },
      },
      schemaVersion: referenceSiteDefinition.schemaVersion,
      rendererVersion: "renderer-v1",
    });
    expect(changedShareImage.contentHash).not.toBe(fingerprint.contentHash);

    const changedKeywords = await createBlogPostArtifactFingerprint({
      definition: referenceSiteDefinition,
      post: { ...post, seo: { ...post.seo, keywords: ["pipeline"] } },
      schemaVersion: referenceSiteDefinition.schemaVersion,
      rendererVersion: "renderer-v1",
    });
    expect(changedKeywords.contentHash).not.toBe(fingerprint.contentHash);
  });
});
