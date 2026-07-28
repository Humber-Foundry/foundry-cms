import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

import {
  assertExactProductionContent,
  assertExactProductionRelease,
} from "./assert-exact-production-content.mjs";

const liveCommit = "a".repeat(40);
const failedCommit = "b".repeat(40);
const expectedCommit = "c".repeat(40);
const publicationId = `publish_${"d".repeat(32)}`;
const bytes = '{"definitionVersion":"1.0.0","site":{"name":"New"}}\n';
const contentHash =
  "3dc0e81afff0e11bf535cfde86b19b872e73c87e6d0053829cdf9198399eb9f9";
const signingSecret = "publication-signing-secret-32-bytes";

function signedMessage(parent = liveCommit) {
  const message =
    `Publish\n\nFoundry-Publish-Id: ${publicationId}\n` +
    `Foundry-Content-Hash: ${contentHash}`;
  const signature = createHmac("sha256", signingSecret)
    .update(
      [
        "foundry-publication-signature-v1",
        parent,
        "packages/site-definition/src/published-site.json",
        contentHash,
        message,
      ].join("\0"),
    )
    .digest("hex");
  return `${message}\nFoundry-Publication-Signature: v1=${signature}`;
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
      "packages/site-definition/src/published-site.json\n",
    ),
    readCommitMessage: vi.fn().mockReturnValue(`${signedMessage()}\n\n`),
    readPublishedContent: vi.fn().mockReturnValue(bytes),
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

  it("allows a build with no unserved content delta", async () => {
    const options = inputs({
      readLiveMarker: vi.fn().mockResolvedValue({
        commitSha: liveCommit,
        contentHash,
      }),
    });

    await expect(
      assertExactProductionContent(options),
    ).resolves.toBeUndefined();
    expect(options.readCommitParents).not.toHaveBeenCalled();
  });

  it("allows one exact Foundry content commit on the live release", async () => {
    await expect(
      assertExactProductionContent(inputs()),
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
