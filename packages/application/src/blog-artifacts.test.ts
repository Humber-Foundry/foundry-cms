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
      mainImage: null,
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
      postRevisionId: "ba3910c5-f244-8ac9-9568-f0b53b831e2b",
      revision: 1,
      contentHash:
        "8a7559c553ea74f71b3db40d2dd622f6e1f905f8c91616867ce0a95739ebae50",
      schemaVersion: "1.6.0",
      rendererVersion: "renderer-v1",
      serializationVersion: "foundry.post-artifact.v1",
      renderedBytesHash:
        "c383a8d9229408105115b7424093f3597749c900a02758ef6bbd925694e75786",
      value:
        "4e0aa7648a9827e435a05894da54c7f6b45e4bfbff0bd98a3837a9da48c0b3c0",
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
