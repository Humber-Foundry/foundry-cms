import { describe, expect, it } from "vitest";

import {
  createBlogPostId,
  createRichTextDocumentFromPlainText,
  referenceSiteDefinition,
} from "@foundry/site-definition";

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
      postRevisionId: "aaf81c86-ae9c-5b0f-93ae-ed5dc494f7b2",
      revision: 1,
      contentHash:
        "83c864bcf45653d03eaa20276ab3276b9a71b854c40fa802cf01e6fc7c9288cc",
      schemaVersion: "1.3.0",
      rendererVersion: "renderer-v1",
      serializationVersion: "foundry.post-artifact.v1",
      renderedBytesHash:
        "b01cd91ebeef5240c3c983a6ab7ef67a14ea70b7889992bdb622984cfac156cd",
      value:
        "aebfa7d9be0dbf60d169bc4047f255f340cf15870bbbed34fcdc8ef29a3dad18",
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
  });
});
