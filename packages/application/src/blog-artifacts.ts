import {
  createBlogPostRenderModel,
  type BlogPost,
  type BlogPostId,
  type SiteDefinition,
  type SiteId,
} from "@foundry/site-definition";

import {
  canonicalJson,
  sha256Text,
  sha256TextBytes,
} from "./deterministic-hash";

export const blogPostArtifactSerializationVersion =
  "foundry.post-artifact.v1";

declare const blogPostRevisionIdBrand: unique symbol;
export type BlogPostRevisionId = string & {
  readonly [blogPostRevisionIdBrand]: "BlogPostRevisionId";
};

export type BlogPostArtifactFingerprint = Readonly<{
  postId: BlogPostId;
  postRevisionId: BlogPostRevisionId;
  revision: number;
  contentHash: string;
  schemaVersion: SiteDefinition["schemaVersion"];
  rendererVersion: string;
  serializationVersion: typeof blogPostArtifactSerializationVersion;
  renderedBytesHash: string;
  value: string;
}>;

export function isBlogPostArtifactFingerprint(
  value: unknown,
): value is BlogPostArtifactFingerprint {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.postId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      candidate.postId,
    ) &&
    typeof candidate.postRevisionId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      candidate.postRevisionId,
    ) &&
    Number.isSafeInteger(candidate.revision) &&
    (candidate.revision as number) >= 1 &&
    typeof candidate.contentHash === "string" &&
    /^[a-f0-9]{64}$/u.test(candidate.contentHash) &&
    candidate.schemaVersion === "1.3.0" &&
    typeof candidate.rendererVersion === "string" &&
    candidate.rendererVersion.length > 0 &&
    candidate.serializationVersion ===
      blogPostArtifactSerializationVersion &&
    typeof candidate.renderedBytesHash === "string" &&
    /^[a-f0-9]{64}$/u.test(candidate.renderedBytesHash) &&
    typeof candidate.value === "string" &&
    /^[a-f0-9]{64}$/u.test(candidate.value)
  );
}

function lengthDelimited(parts: ReadonlyArray<string>): string {
  const encoder = new TextEncoder();
  return parts
    .map((part) => `${encoder.encode(part).byteLength}:${part}`)
    .join("");
}

export async function createBlogPostRevisionId(
  siteId: SiteId,
  postId: BlogPostId,
  revision: number,
  contentHash: string,
): Promise<BlogPostRevisionId> {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new TypeError("blog_post_revision_invalid");
  }
  if (!/^[a-f0-9]{64}$/u.test(contentHash)) {
    throw new TypeError("blog_post_content_hash_invalid");
  }
  const bytes = await sha256TextBytes(
    lengthDelimited([
      "foundry.post-revision-id.v1",
      siteId,
      postId,
      String(revision),
      contentHash,
    ]),
  );
  const uuid = bytes.slice(0, 16);
  uuid[6] = (uuid[6]! & 0x0f) | 0x50;
  uuid[8] = (uuid[8]! & 0x3f) | 0x80;
  const hex = [...uuid]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-") as BlogPostRevisionId;
}

export async function createBlogPostArtifactFingerprint(input: {
  definition: SiteDefinition;
  post: BlogPost;
  schemaVersion: SiteDefinition["schemaVersion"];
  rendererVersion: string;
}): Promise<BlogPostArtifactFingerprint> {
  const contentHash = await sha256Text(canonicalJson(input.post));
  const postRevisionId = await createBlogPostRevisionId(
    input.definition.site.id,
    input.post.id,
    input.post.revision,
    contentHash,
  );
  const renderedBytesHash = await sha256Text(
    canonicalJson(createBlogPostRenderModel(input.definition, input.post)),
  );
  const value = await sha256Text(
    lengthDelimited([
      blogPostArtifactSerializationVersion,
      input.post.id,
      postRevisionId,
      contentHash,
      input.schemaVersion,
      input.rendererVersion,
      blogPostArtifactSerializationVersion,
      renderedBytesHash,
    ]),
  );
  return Object.freeze({
    postId: input.post.id,
    postRevisionId,
    revision: input.post.revision,
    contentHash,
    schemaVersion: input.schemaVersion,
    rendererVersion: input.rendererVersion,
    serializationVersion: blogPostArtifactSerializationVersion,
    renderedBytesHash,
    value,
  });
}

export async function createBlogPostArtifactFingerprints(
  revision: Pick<ContentRevisionLike, "definition" | "inputs">,
): Promise<ReadonlyArray<BlogPostArtifactFingerprint>> {
  return Promise.all(
    revision.definition.blog.posts.map((post) =>
      createBlogPostArtifactFingerprint({
        definition: revision.definition,
        post,
        schemaVersion: revision.inputs.schemaVersion,
        rendererVersion: revision.inputs.rendererVersion,
      }),
    ),
  );
}

type ContentRevisionLike = Readonly<{
  definition: SiteDefinition;
  inputs: Readonly<{
    schemaVersion: SiteDefinition["schemaVersion"];
    rendererVersion: string;
  }>;
}>;
