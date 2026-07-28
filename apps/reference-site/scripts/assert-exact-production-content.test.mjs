import { describe, expect, it, vi } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

import { referenceSiteDefinition } from "@foundry/site-definition";

import {
  assertExactProductionContent,
  assertExactProductionRelease,
} from "./assert-exact-production-content.mjs";

const liveCommit = "a".repeat(40);
const failedCommit = "b".repeat(40);
const expectedCommit = "c".repeat(40);
const publicationId = `publish_${"d".repeat(32)}`;
const bytes =
  '{"definitionVersion":"1.1.0","schemaVersion":"1.1.0",' +
  '"site":{"name":"New"},"home":{"media":[],"sections":[]}}\n';
const richTextPath = "content/rich-text/section_contact/body.md";
const richTextBytes = "A deterministic **Markdown** artifact.\n";
const signingSecret = "publication-signing-secret-32-bytes";

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalHash(value) {
  return createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex");
}

const contentHash = canonicalHash(JSON.parse(bytes));
const trackedPublishedBytes = readFileSync(
  new URL(
    "../../../packages/site-definition/src/published-site.json",
    import.meta.url,
  ),
  "utf8",
);
const runtimePublishedContentHash = canonicalHash(referenceSiteDefinition);

function defaultArtifacts() {
  return [
    {
      path: "packages/site-definition/src/published-site.json",
      bytes,
    },
    { path: richTextPath, bytes: richTextBytes },
  ];
}

function artifactHash(artifacts = defaultArtifacts()) {
  const manifest = [...artifacts]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((artifact) => ({
    byteLength: Buffer.byteLength(artifact.bytes),
    path: artifact.path,
    sha256: createHash("sha256")
      .update(artifact.bytes)
      .digest("hex"),
    }));
  return createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex");
}

function signedMessage(
  parent = liveCommit,
  artifacts = defaultArtifacts(),
) {
  const message =
    `Publish\n\nFoundry-Publish-Id: ${publicationId}\n` +
    `Foundry-Content-Hash: ${contentHash}`;
  const signature = createHmac("sha256", signingSecret)
    .update(
      [
        "foundry-publication-signature-v2",
        parent,
        artifactHash(artifacts),
        contentHash,
        message,
      ].join("\0"),
    )
    .digest("hex");
  return `${message}\nFoundry-Publication-Signature: v2=${signature}`;
}

function inputs(overrides = {}) {
  return {
    environment: {
      WORKERS_CI_COMMIT_SHA: expectedCommit,
      FOUNDRY_PUBLIC_ORIGIN: "https://site.example",
      FOUNDRY_PUBLICATION_SIGNING_SECRET: signingSecret,
    },
    readLiveMarker: vi.fn().mockResolvedValue({
      commitSha: liveCommit,
      contentHash: "e".repeat(64),
    }),
    readCommitParents: vi.fn().mockReturnValue(
      `${expectedCommit} ${liveCommit}\n`,
    ),
    readChangedPaths: vi.fn().mockReturnValue(
      "packages/site-definition/src/published-site.json\n" +
        `${richTextPath}\n`,
    ),
    readCommitMessage: vi.fn().mockReturnValue(`${signedMessage()}\n\n`),
    readPublishedContent: vi.fn().mockReturnValue(bytes),
    readManagedRichTextPaths: vi.fn().mockReturnValue(
      `${richTextPath}\n`,
    ),
    readArtifact: vi.fn((_commit, path) =>
      path === richTextPath ? richTextBytes : bytes,
    ),
    ...overrides,
  };
}

describe("exact production content authorization", () => {
  it("verifies that the exact build commit is live", async () => {
    await expect(
      assertExactProductionRelease({
        environment: { WORKERS_CI_COMMIT_SHA: expectedCommit },
        readLiveMarker: vi.fn().mockResolvedValue({
          commitSha: expectedCommit,
          contentHash,
        }),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects unchanged content served by an older commit", async () => {
    await expect(
      assertExactProductionRelease({
        environment: { WORKERS_CI_COMMIT_SHA: expectedCommit },
        readLiveMarker: vi.fn().mockResolvedValue({
          commitSha: liveCommit,
          contentHash,
        }),
      }),
    ).rejects.toThrow("exact_release_commit_not_live");
  });

  it("rejects a redirected release marker", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://other.example/marker.json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(
        assertExactProductionRelease({
          environment: {
            WORKERS_CI_COMMIT_SHA: expectedCommit,
            FOUNDRY_PUBLIC_ORIGIN: "https://site.example",
          },
        }),
      ).rejects.toThrow("exact_live_marker_unavailable");
      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({ redirect: "manual" }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("allows a build with no unserved content delta", async () => {
    const options = inputs({
      readLiveMarker: vi.fn().mockResolvedValue({
        commitSha: liveCommit,
        contentHash,
      }),
      readChangedPaths: vi
        .fn()
        .mockReturnValue("apps/reference-site/app/page.tsx\n"),
    });

    await expect(
      assertExactProductionContent(options),
    ).resolves.toBeUndefined();
    expect(options.readCommitParents).not.toHaveBeenCalled();
  });

  it("authorizes unchanged legacy bytes through the runtime schema projection", async () => {
    const options = inputs({
      readLiveMarker: vi.fn().mockResolvedValue({
        commitSha: liveCommit,
        contentHash: runtimePublishedContentHash,
      }),
      readChangedPaths: vi
        .fn()
        .mockReturnValue("apps/reference-site/app/page.tsx\n"),
      readPublishedContent: vi
        .fn()
        .mockReturnValue(trackedPublishedBytes),
    });

    await expect(
      assertExactProductionContent(options),
    ).resolves.toBeUndefined();
    expect(options.readCommitParents).not.toHaveBeenCalled();
  });

  it("does not let a rename out of the managed tree bypass equal JSON content", async () => {
    await expect(
      assertExactProductionContent(
        inputs({
          readLiveMarker: vi.fn().mockResolvedValue({
            commitSha: liveCommit,
            contentHash,
          }),
          readChangedPaths: vi
            .fn()
            .mockReturnValue(`${richTextPath}\ndocs/body.md\n`),
          readCommitMessage: vi
            .fn()
            .mockReturnValue("Ordinary code commit\n"),
        }),
      ),
    ).rejects.toThrow("exact_content_release_not_authorized");
  });

  it("allows one exact Foundry JSON and Markdown artifact commit on the live release", async () => {
    await expect(
      assertExactProductionContent(inputs()),
    ).resolves.toBeUndefined();
  });

  it("rejects an unrelated file in the publication commit", async () => {
    await expect(
      assertExactProductionContent(
        inputs({
          readChangedPaths: vi.fn().mockReturnValue(
            "packages/site-definition/src/published-site.json\n" +
              "apps/reference-site/app/page.tsx\n",
          ),
        }),
      ),
    ).rejects.toThrow("exact_content_release_not_authorized");
  });

  it("allows an obsolete managed Markdown path to be removed", async () => {
    const currentArtifacts = [
      {
        path: "packages/site-definition/src/published-site.json",
        bytes,
      },
    ];
    await expect(
      assertExactProductionContent(
        inputs({
          readChangedPaths: vi.fn().mockReturnValue(
            "packages/site-definition/src/published-site.json\n" +
              "content/rich-text/section_old/body.md\n",
          ),
          readManagedRichTextPaths: vi.fn().mockReturnValue(""),
          readCommitMessage: vi
            .fn()
            .mockReturnValue(
              `${signedMessage(liveCommit, currentArtifacts)}\n`,
            ),
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("blocks a later build from inheriting a failed content commit", async () => {
    await expect(
      assertExactProductionContent(
        inputs({
          readCommitParents: vi.fn().mockReturnValue(
            `${expectedCommit} ${failedCommit}\n`,
          ),
        }),
      ),
    ).rejects.toThrow("exact_content_release_not_authorized");
  });

  it("rejects a forged Foundry trailer without the publication signature", async () => {
    await expect(
      assertExactProductionContent(
        inputs({
          readCommitMessage: vi.fn().mockReturnValue(
            `Publish\n\nFoundry-Publish-Id: ${publicationId}\n` +
              `Foundry-Content-Hash: ${contentHash}`,
          ),
        }),
      ),
    ).rejects.toThrow("exact_content_release_not_authorized");
  });

  it("requires an existing live marker baseline", async () => {
    const readLiveMarker = vi
      .fn()
      .mockRejectedValue(new Error("exact_live_marker_unavailable"));

    await expect(
      assertExactProductionContent(
        inputs({
          readLiveMarker,
        }),
      ),
    ).rejects.toThrow("exact_live_marker_unavailable");
  });
});
