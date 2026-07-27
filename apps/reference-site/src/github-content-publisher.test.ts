import { beforeAll, describe, expect, it, vi } from "vitest";
import { exportPKCS8, generateKeyPair } from "jose";

import {
  createContentActorId,
  createContentPublicationId,
  createContentWorkspaceId,
  createHumanMembershipId,
} from "@foundry/application";

import {
  GitHubContentPublisherConfigurationError,
  createGitHubContentPublisher,
  readGitHubContentPublisherConfiguration,
} from "./github-content-publisher";

let privateKey: string;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = await exportPKCS8(pair.privateKey);
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const configurationInputs = {
  appId: "123",
  installationId: "456",
  privateKey: "",
  owner: "client-owner",
  repository: "client-site",
  productionBranch: "main",
  publicOrigin: "https://site.example",
  deploymentCheckName: "Cloudflare Workers",
};

describe("GitHub content publisher", () => {
  it("requires installation-scoped publication configuration", () => {
    expect(() =>
      readGitHubContentPublisherConfiguration({}),
    ).toThrow(GitHubContentPublisherConfigurationError);
    expect(
      readGitHubContentPublisherConfiguration({
        FOUNDRY_GITHUB_APP_ID: "123",
        FOUNDRY_GITHUB_INSTALLATION_ID: "456",
        FOUNDRY_GITHUB_PRIVATE_KEY: "line-1\\nline-2",
        FOUNDRY_GITHUB_OWNER: "client-owner",
        FOUNDRY_GITHUB_REPOSITORY: "client-site",
        FOUNDRY_PUBLIC_ORIGIN: "https://site.example/path",
      }),
    ).toEqual({
      ...configurationInputs,
      privateKey: "line-1\nline-2",
      deploymentCheckName: "Cloudflare",
    });
  });

  it("creates one tree and bot commit before a non-force production ref update", async () => {
    const expectedHead = "a".repeat(40);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ token: "installation-token" }))
      .mockResolvedValueOnce(json({ object: { sha: expectedHead } }))
      .mockResolvedValueOnce(json({ tree: { sha: "base-tree-sha" } }))
      .mockResolvedValueOnce(json({ sha: "blob-sha" }))
      .mockResolvedValueOnce(json({ sha: "tree-sha" }))
      .mockResolvedValueOnce(json({ sha: "c".repeat(40) }))
      .mockResolvedValueOnce(json({ object: { sha: "c".repeat(40) } }));
    const publisher = createGitHubContentPublisher({
      configuration: { ...configurationInputs, privateKey },
      fetch: fetchMock,
      now: () => new Date("2026-07-27T10:00:00Z"),
    });

    await expect(
      publisher.createCommit({
        publishId: createContentPublicationId(
          `publish_${"1".repeat(32)}`,
        ),
        workspaceId: createContentWorkspaceId("workspace_publish"),
        revision: 3,
        approvedBy: createHumanMembershipId("membership-editor"),
        contributors: [createContentActorId("membership-editor")],
        contentHash: "b".repeat(64),
        expectedHead,
        path: "packages/site-definition/src/published-site.json",
        bytes: "{\"schemaVersion\":\"1.0.0\"}\n",
        message: "Publish\n\nFoundry-Publish-Id: publish_11111111111111111111111111111111",
      }),
    ).resolves.toEqual({
      state: "committed",
      commitSha: "c".repeat(40),
    });

    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(fetchMock.mock.calls[4]![1]).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          base_tree: "base-tree-sha",
          tree: [
            {
              path: "packages/site-definition/src/published-site.json",
              mode: "100644",
              type: "blob",
              sha: "blob-sha",
            },
          ],
        }),
      }),
    );
    expect(fetchMock.mock.calls[5]![1]).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          message:
            "Publish\n\nFoundry-Publish-Id: publish_11111111111111111111111111111111",
          tree: "tree-sha",
          parents: [expectedHead],
        }),
      }),
    );
    expect(fetchMock.mock.calls[6]![1]).toEqual(
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ sha: "c".repeat(40), force: false }),
      }),
    );
  });

  it("fails closed before creating Git objects when the expected head moved", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ token: "installation-token" }))
      .mockResolvedValueOnce(json({ object: { sha: "d".repeat(40) } }));
    const publisher = createGitHubContentPublisher({
      configuration: { ...configurationInputs, privateKey },
      fetch: fetchMock,
    });

    await expect(
      publisher.createCommit({
        publishId: createContentPublicationId(
          `publish_${"1".repeat(32)}`,
        ),
        workspaceId: createContentWorkspaceId("workspace_publish"),
        revision: 3,
        approvedBy: createHumanMembershipId("membership-editor"),
        contributors: [],
        contentHash: "b".repeat(64),
        expectedHead: "a".repeat(40),
        path: "packages/site-definition/src/published-site.json",
        bytes: "{}\n",
        message: "Publish",
      }),
    ).resolves.toEqual({
      state: "blocked",
      detail: "production_head_moved",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("requires two uncached exact release-marker reads before reporting live", async () => {
    const expected = {
      commitSha: "c".repeat(40),
      contentHash: "d".repeat(64),
      schemaVersion: "1.0.0" as const,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(expected))
      .mockResolvedValueOnce(json(expected));
    const publisher = createGitHubContentPublisher({
      configuration: { ...configurationInputs, privateKey },
      fetch: fetchMock,
    });

    await expect(publisher.isReleaseLive(expected)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toContain(
        "/.well-known/foundry-release.json?foundry_probe=",
      );
      expect(init).toEqual(
        expect.objectContaining({
          cache: "no-store",
          headers: { "cache-control": "no-cache" },
        }),
      );
    }
  });

  it("does not report live when either marker read differs", async () => {
    const expected = {
      commitSha: "c".repeat(40),
      contentHash: "d".repeat(64),
      schemaVersion: "1.0.0" as const,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(expected))
      .mockResolvedValueOnce(
        json({ ...expected, contentHash: "e".repeat(64) }),
      );
    const publisher = createGitHubContentPublisher({
      configuration: { ...configurationInputs, privateKey },
      fetch: fetchMock,
    });

    await expect(publisher.isReleaseLive(expected)).resolves.toBe(false);
  });

  it("uses only the configured Cloudflare check to report build state", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ token: "installation-token" }))
      .mockResolvedValueOnce(
        json({
          check_runs: [
            {
              name: "unit tests",
              status: "completed",
              conclusion: "success",
            },
            {
              name: "Cloudflare Workers",
              status: "in_progress",
              conclusion: null,
            },
            {
              name: "Cloudflare Workers",
              status: "completed",
              conclusion: "failure",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(json({ statuses: [] }));
    const publisher = createGitHubContentPublisher({
      configuration: { ...configurationInputs, privateKey },
      fetch: fetchMock,
    });

    await expect(
      publisher.getDeploymentStatus("c".repeat(40)),
    ).resolves.toBe("building");
  });

  it("reconciles an ambiguous publish by its exact commit trailer", async () => {
    const publishId = createContentPublicationId(
      `publish_${"1".repeat(32)}`,
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ token: "installation-token" }))
      .mockResolvedValueOnce(
        json([
          {
            sha: "c".repeat(40),
            commit: {
              message: `Publish\n\nFoundry-Publish-Id: ${publishId}`,
            },
          },
        ]),
      );
    const publisher = createGitHubContentPublisher({
      configuration: { ...configurationInputs, privateKey },
      fetch: fetchMock,
    });

    await expect(publisher.reconcileCommit(publishId)).resolves.toEqual({
      state: "committed",
      commitSha: "c".repeat(40),
    });
  });
});
