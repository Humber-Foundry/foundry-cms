import { describe, expect, it, vi } from "vitest";

import { assertExactProductionContent } from "./assert-exact-production-content.mjs";

const liveCommit = "a".repeat(40);
const failedCommit = "b".repeat(40);
const expectedCommit = "c".repeat(40);
const publicationId = `publish_${"d".repeat(32)}`;
const bytes = '{"definitionVersion":"1.0.0","site":{"name":"New"}}\n';
const contentHash =
  "3dc0e81afff0e11bf535cfde86b19b872e73c87e6d0053829cdf9198399eb9f9";

function inputs(overrides = {}) {
  return {
    environment: {
      WORKERS_CI_COMMIT_SHA: expectedCommit,
      FOUNDRY_PUBLIC_ORIGIN: "https://site.example",
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
    readCommitMessage: vi.fn().mockReturnValue(
      `Publish\n\nFoundry-Publish-Id: ${publicationId}\nFoundry-Content-Hash: ${contentHash}\n`,
    ),
    readPublishedContent: vi.fn().mockReturnValue(bytes),
    ...overrides,
  };
}

describe("exact production content authorization", () => {
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

  it("permits unavailable-marker bootstrap only for one exact commit", async () => {
    const readLiveMarker = vi
      .fn()
      .mockRejectedValue(new Error("exact_live_marker_unavailable"));

    await expect(
      assertExactProductionContent(
        inputs({
          environment: {
            WORKERS_CI_COMMIT_SHA: expectedCommit,
            FOUNDRY_PUBLIC_ORIGIN: "https://site.example",
            FOUNDRY_INITIAL_RELEASE_COMMIT_SHA: expectedCommit,
          },
          readLiveMarker,
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertExactProductionContent(
        inputs({
          environment: {
            WORKERS_CI_COMMIT_SHA: expectedCommit,
            FOUNDRY_PUBLIC_ORIGIN: "https://site.example",
            FOUNDRY_INITIAL_RELEASE_COMMIT_SHA: failedCommit,
          },
          readLiveMarker,
        }),
      ),
    ).rejects.toThrow("exact_live_marker_unavailable");
  });
});
