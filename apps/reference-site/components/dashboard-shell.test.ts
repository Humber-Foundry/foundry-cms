import { describe, expect, it } from "vitest";

import type { ContentRevision } from "@foundry/application";
import {
  createBlogPostId,
  createRichTextDocumentFromPlainText,
  referenceSiteDefinition,
} from "@foundry/site-definition";

import {
  contentWorkspaceRequiresSchemaRecovery,
  verifiedPublicBlogPostIds,
} from "./dashboard-shell";

describe("dashboard content-workspace compatibility", () => {
  const revision = {
    definition: referenceSiteDefinition,
    inputs: {
      schemaVersion: "1.3.0",
    },
  } as unknown as ContentRevision;

  it("uses a recovery shell instead of mounting current-schema fields for a legacy revision", () => {
    expect(
      contentWorkspaceRequiresSchemaRecovery(referenceSiteDefinition, {
        ...revision,
        inputs: { ...revision.inputs, schemaVersion: "1.0.0" },
      }),
    ).toBe(true);
  });

  it("mounts the editor for a current-schema revision", () => {
    expect(
      contentWorkspaceRequiresSchemaRecovery(
        referenceSiteDefinition,
        revision,
      ),
    ).toBe(false);
  });

  it("passes only verified-public posts to lifecycle controls", () => {
    const publicId = createBlogPostId(
      "00000000-0000-4000-8000-000000000011",
    );
    const unpublishedId = createBlogPostId(
      "00000000-0000-4000-8000-000000000012",
    );
    const post = {
      revision: 1,
      collectionState: "active" as const,
      slug: "verified-state",
      title: "Verified state",
      excerpt: "Verified lifecycle wiring.",
      seo: {
        title: "Verified state | Foundry",
        description: "Verified lifecycle wiring.",
      },
      body: createRichTextDocumentFromPlainText("Verified state."),
    };
    const definition = {
      ...referenceSiteDefinition,
      blog: {
        ...referenceSiteDefinition.blog,
        posts: [
          {
            ...post,
            id: publicId,
            targetVisibility: "public" as const,
          },
          {
            ...post,
            id: unpublishedId,
            slug: "verified-unpublished",
            targetVisibility: "unpublished" as const,
          },
        ],
      },
    };

    expect(verifiedPublicBlogPostIds(definition)).toEqual([publicId]);
  });
});
