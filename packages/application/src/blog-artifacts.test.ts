import { describe, expect, it } from "vitest";

import {
  createBlogPostId,
  createRichTextDocumentFromPlainText,
  referenceSiteDefinition,
} from "@foundry/site-definition";

import { createBlogPostArtifactFingerprint } from "./blog-artifacts";

describe("blog post artifact fingerprint", () => {
  it("binds the exact stable revision and rendered post inputs", async () => {
    const fingerprint = await createBlogPostArtifactFingerprint({
      siteId: referenceSiteDefinition.site.id,
      post: {
        id: createBlogPostId(
          "00000000-0000-4000-8000-000000000009",
        ),
        revision: 1,
        collectionState: "active",
        targetVisibility: "public",
        slug: "exact-pipeline",
        title: "Exact pipeline",
        excerpt: "Published through the site pipeline.",
        seo: {
          title: "Exact pipeline | Foundry",
          description: "A post using the exact site publication pipeline.",
        },
        body: createRichTextDocumentFromPlainText("Exact post body."),
      },
      schemaVersion: referenceSiteDefinition.schemaVersion,
      rendererVersion: "renderer-v1",
    });

    expect(fingerprint).toEqual({
      postId: "00000000-0000-4000-8000-000000000009",
      postRevisionId: "41ade042-9d57-5757-881b-d176d195e25d",
      revision: 1,
      contentHash:
        "83c864bcf45653d03eaa20276ab3276b9a71b854c40fa802cf01e6fc7c9288cc",
      schemaVersion: "1.3.0",
      rendererVersion: "renderer-v1",
      serializationVersion: "foundry.post-artifact.v1",
      renderedBytesHash:
        "f37d0d3bd2ae81ed05b4b5620e9c899220ec4c5d2cf4d8a94609e205fed84d55",
      value:
        "b5ac05a73b2f5ebf335900915c4ddd572c790e71ae500e36f90a955107feff84",
    });
  });
});
