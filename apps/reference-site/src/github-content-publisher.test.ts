import { beforeAll, describe, expect, it, vi } from "vitest";
import { exportPKCS8, generateKeyPair } from "jose";
import { createHash } from "node:crypto";

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
  cloudflareAccountId: "account-123",
  cloudflareScriptTag: "script-789",
  cloudflareBuildTriggerId: "trigger-456",
  cloudflareApiToken: "cloudflare-api-token",
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
        FOUNDRY_CLOUDFLARE_ACCOUNT_ID: "account-123",
        FOUNDRY_CLOUDFLARE_SCRIPT_TAG: "script-789",
        FOUNDRY_CLOUDFLARE_BUILD_TRIGGER_ID: "trigger-456",
        FOUNDRY_CLOUDFLARE_API_TOKEN: "cloudflare-api-token",
      }),
    ).toEqual({
      ...configurationInputs,
      privateKey: "line-1\nline-2",
      deploymentCheckName: "Cloudflare",
    });
    expect(() =>
      readGitHubContentPublisherConfiguration({
        FOUNDRY_GITHUB_APP_ID: "123",
        FOUNDRY_GITHUB_INSTALLATION_ID: "456",
        FOUNDRY_GITHUB_PRIVATE_KEY: "private-key",
        FOUNDRY_GITHUB_OWNER: "client-owner",
        FOUNDRY_GITHUB_REPOSITORY: "client-site",
        FOUNDRY_PUBLIC_ORIGIN: "http://site.example",
        FOUNDRY_CLOUDFLARE_ACCOUNT_ID: "account-123",
        FOUNDRY_CLOUDFLARE_SCRIPT_TAG: "script-789",
        FOUNDRY_CLOUDFLARE_BUILD_TRIGGER_ID: "trigger-456",
        FOUNDRY_CLOUDFLARE_API_TOKEN: "cloudflare-api-token",
      }),
    ).toThrow(GitHubContentPublisherConfigurationError);
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
        assertLease: async () => true,
      }),
    ).resolves.toEqual({
      state: "committed",
      commitSha: "c".repeat(40),
    });

    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(fetchMock.mock.calls[0]![1]).toEqual(
      expect.objectContaining({
        method: "POST",
        signal: expect.any(AbortSignal),
      }),
    );
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
        assertLease: async () => true,
      }),
    ).resolves.toEqual({
      state: "blocked",
      detail: "production_head_moved",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports an explicit pre-commit Git rejection as failed", async () => {
    const expectedHead = "a".repeat(40);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ token: "installation-token" }))
      .mockResolvedValueOnce(json({ object: { sha: expectedHead } }))
      .mockResolvedValueOnce(json({ tree: { sha: "base-tree-sha" } }))
      .mockResolvedValueOnce(json({ message: "Validation Failed" }, 422));
    const publisher = createGitHubContentPublisher({
      configuration: { ...configurationInputs, privateKey },
      fetch: fetchMock,
    });

    await expect(
      publisher.createCommit({
        publishId: createContentPublicationId(
          `publish_${"2".repeat(32)}`,
        ),
        workspaceId: createContentWorkspaceId("workspace_publish"),
        revision: 3,
        approvedBy: createHumanMembershipId("membership-editor"),
        contributors: [],
        contentHash: "b".repeat(64),
        expectedHead,
        path: "packages/site-definition/src/published-site.json",
        bytes: "{}\n",
        message: "Publish",
        assertLease: async () => true,
      }),
    ).resolves.toEqual({
      state: "failed",
      detail: "git_operation_failed",
    });
  });

  it("keeps a lost commit response unknown for reconciliation", async () => {
    const expectedHead = "a".repeat(40);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ token: "installation-token" }))
      .mockResolvedValueOnce(json({ object: { sha: expectedHead } }))
      .mockResolvedValueOnce(json({ tree: { sha: "base-tree-sha" } }))
      .mockResolvedValueOnce(json({ sha: "blob-sha" }))
      .mockResolvedValueOnce(json({ sha: "tree-sha" }))
      .mockRejectedValueOnce(new TypeError("connection reset"));
    const publisher = createGitHubContentPublisher({
      configuration: { ...configurationInputs, privateKey },
      fetch: fetchMock,
    });

    await expect(
      publisher.createCommit({
        publishId: createContentPublicationId(
          `publish_${"4".repeat(32)}`,
        ),
        workspaceId: createContentWorkspaceId("workspace_publish"),
        revision: 3,
        approvedBy: createHumanMembershipId("membership-editor"),
        contributors: [],
        contentHash: "b".repeat(64),
        expectedHead,
        path: "packages/site-definition/src/published-site.json",
        bytes: "{}\n",
        message: "Publish",
        assertLease: async () => true,
      }),
    ).resolves.toEqual({
      state: "unknown",
      detail: "git_result_unknown",
    });
  });

  it("binds approvals to non-secret destination and deployment configuration", async () => {
    const buildConfiguration = {
      success: true,
      result: [
        {
          trigger_uuid: "trigger-456",
          external_script_id: "script-789",
          build_command: "npm run build",
          deploy_command: "npm run deploy",
          root_directory: "/",
          branch_includes: ["main"],
          branch_excludes: [],
          path_includes: ["**"],
          path_excludes: [],
          build_caching_enabled: true,
          repo_connection: {
            repo_connection_uuid: "connection-1",
            provider_type: "github",
            provider_account_id: "account-owner",
            repo_id: "repository-1",
          },
        },
      ],
    };
    const environmentConfiguration = {
      success: true,
      result: {
        NODE_ENV: {
          is_secret: false,
          value: "production",
          created_on: "2026-07-27T00:00:00Z",
        },
        DEPLOY_TOKEN: {
          is_secret: true,
          value: null,
          created_on: "2026-07-27T00:00:00Z",
        },
      },
    };
    const configurationFetch = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) =>
        json(
          String(input).endsWith("/environment_variables")
            ? environmentConfiguration
            : buildConfiguration,
        ),
      );
    const publisher = createGitHubContentPublisher({
      configuration: { ...configurationInputs, privateKey },
      fetch: configurationFetch,
    });
    const rotatedSecretPublisher = createGitHubContentPublisher({
      configuration: {
        ...configurationInputs,
        privateKey: `${privateKey}\n`,
        cloudflareApiToken: "rotated-secret",
      },
      fetch: configurationFetch,
    });
    const differentDestinationPublisher = createGitHubContentPublisher({
      configuration: {
        ...configurationInputs,
        privateKey,
        productionBranch: "production",
      },
      fetch: configurationFetch,
    });
    const changedBuildPublisher = createGitHubContentPublisher({
      configuration: { ...configurationInputs, privateKey },
      fetch: vi
        .fn<typeof fetch>()
        .mockImplementation(async (input) =>
          json(
            String(input).endsWith("/environment_variables")
              ? environmentConfiguration
              : {
                  ...buildConfiguration,
                  result: [
                    {
                      ...buildConfiguration.result[0],
                      deploy_command: "npm run deploy:changed",
                    },
                  ],
                },
          ),
        ),
    });

    await expect(publisher.getChannelConfigurationHash()).resolves.toBe(
      await rotatedSecretPublisher.getChannelConfigurationHash(),
    );
    await expect(
      differentDestinationPublisher.getChannelConfigurationHash(),
    ).resolves.not.toBe(
      await publisher.getChannelConfigurationHash(),
    );
    await expect(
      changedBuildPublisher.getChannelConfigurationHash(),
    ).rejects.toThrow("cloudflare_build_configuration_invalid");
  });

  it("retries a Cloudflare build for the exact committed revision", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        success: true,
        result: { build_uuid: "build-123" },
      }),
    );
    const publisher = createGitHubContentPublisher({
      configuration: { ...configurationInputs, privateKey },
      fetch: fetchMock,
    });

    await expect(
      publisher.retryDeployment("c".repeat(40)),
    ).resolves.toEqual({
      state: "requested",
      deploymentId: "build-123",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/account-123/builds/triggers/trigger-456/builds",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer cloudflare-api-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          branch: "main",
          commit_hash: "c".repeat(40),
        }),
      }),
    );
  });

  it("polls an exact manual build through the Cloudflare Builds API", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        success: true,
        result: {
          status: "stopped",
          build_outcome: "success",
          build_trigger_metadata: {
            commit_hash: "c".repeat(40),
          },
        },
      }),
    );
    const publisher = createGitHubContentPublisher({
      configuration: { ...configurationInputs, privateKey },
      fetch: fetchMock,
    });

    await expect(
      publisher.getDeploymentStatus("c".repeat(40), "build-123"),
    ).resolves.toBe("deployed");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/account-123/builds/builds/build-123",
      expect.objectContaining({
        headers: {
          authorization: "Bearer cloudflare-api-token",
        },
      }),
    );
  });

  it("fails a skipped or wrong-commit manual build", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          success: true,
          result: {
            status: "stopped",
            build_outcome: "skipped",
            build_trigger_metadata: {
              commit_hash: "c".repeat(40),
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        json({
          success: true,
          result: {
            status: "stopped",
            build_outcome: "success",
            build_trigger_metadata: {
              commit_hash: "d".repeat(40),
            },
          },
        }),
      );
    const publisher = createGitHubContentPublisher({
      configuration: { ...configurationInputs, privateKey },
      fetch: fetchMock,
    });

    await expect(
      publisher.getDeploymentStatus("c".repeat(40), "build-skipped"),
    ).resolves.toBe("failed");
    await expect(
      publisher.getDeploymentStatus("c".repeat(40), "build-wrong"),
    ).resolves.toBe("failed");
  });

  it("classifies an explicit non-fast-forward ref rejection as a moved head", async () => {
    const expectedHead = "a".repeat(40);
    const commitSha = "c".repeat(40);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ token: "installation-token" }))
      .mockResolvedValueOnce(json({ object: { sha: expectedHead } }))
      .mockResolvedValueOnce(json({ tree: { sha: "base-tree-sha" } }))
      .mockResolvedValueOnce(json({ sha: "blob-sha" }))
      .mockResolvedValueOnce(json({ sha: "tree-sha" }))
      .mockResolvedValueOnce(json({ sha: commitSha }))
      .mockResolvedValueOnce(
        json({ message: "Update is not a fast forward" }, 422),
      );
    const publisher = createGitHubContentPublisher({
      configuration: { ...configurationInputs, privateKey },
      fetch: fetchMock,
    });

    await expect(
      publisher.createCommit({
        publishId: createContentPublicationId(
          `publish_${"3".repeat(32)}`,
        ),
        workspaceId: createContentWorkspaceId("workspace_publish"),
        revision: 3,
        approvedBy: createHumanMembershipId("membership-editor"),
        contributors: [],
        contentHash: "b".repeat(64),
        expectedHead,
        path: "packages/site-definition/src/published-site.json",
        bytes: "{}\n",
        message: "Publish",
        assertLease: async () => true,
      }),
    ).resolves.toEqual({
      state: "blocked",
      detail: "production_head_moved",
    });
  });

  it("classifies an explicit commit creation rejection as failed", async () => {
    const expectedHead = "a".repeat(40);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ token: "installation-token" }))
      .mockResolvedValueOnce(json({ object: { sha: expectedHead } }))
      .mockResolvedValueOnce(json({ tree: { sha: "base-tree-sha" } }))
      .mockResolvedValueOnce(json({ sha: "blob-sha" }))
      .mockResolvedValueOnce(json({ sha: "tree-sha" }))
      .mockResolvedValueOnce(json({ message: "Validation Failed" }, 422));
    const publisher = createGitHubContentPublisher({
      configuration: { ...configurationInputs, privateKey },
      fetch: fetchMock,
    });

    await expect(
      publisher.createCommit({
        publishId: createContentPublicationId(
          `publish_${"3".repeat(32)}`,
        ),
        workspaceId: createContentWorkspaceId("workspace_publish"),
        revision: 3,
        approvedBy: createHumanMembershipId("membership-editor"),
        contributors: [],
        contentHash: "b".repeat(64),
        expectedHead,
        path: "packages/site-definition/src/published-site.json",
        bytes: "{}\n",
        message: "Publish",
        assertLease: async () => true,
      }),
    ).resolves.toEqual({
      state: "failed",
      detail: "git_operation_failed",
    });
  });

  it("preserves an exact candidate after another explicit ref rejection", async () => {
    const expectedHead = "a".repeat(40);
    const commitSha = "c".repeat(40);
    const publishId = createContentPublicationId(
      `publish_${"4".repeat(32)}`,
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ token: "installation-token" }))
      .mockResolvedValueOnce(json({ object: { sha: expectedHead } }))
      .mockResolvedValueOnce(json({ tree: { sha: "base-tree-sha" } }))
      .mockResolvedValueOnce(json({ sha: "blob-sha" }))
      .mockResolvedValueOnce(json({ sha: "tree-sha" }))
      .mockResolvedValueOnce(json({ sha: commitSha }))
      .mockResolvedValueOnce(json({ message: "Reference rejected" }, 403));
    const publisher = createGitHubContentPublisher({
      configuration: { ...configurationInputs, privateKey },
      fetch: fetchMock,
    });

    await expect(
      publisher.createCommit({
        publishId,
        workspaceId: createContentWorkspaceId("workspace_publish"),
        revision: 3,
        approvedBy: createHumanMembershipId("membership-editor"),
        contributors: [],
        contentHash: "b".repeat(64),
        expectedHead,
        path: "packages/site-definition/src/published-site.json",
        bytes: "{}\n",
        message: `Publish\n\nFoundry-Publish-Id: ${publishId}`,
        assertLease: async () => true,
      }),
    ).resolves.toEqual({
      state: "unknown",
      detail: `git_reference_result_unknown:${commitSha}`,
    });
  });

  it("verifies and retries only the exact retained commit ref", async () => {
    const expectedHead = "a".repeat(40);
    const commitSha = "c".repeat(40);
    const bytes = "{}\n";
    const blobSha = createHash("sha1")
      .update(`blob ${Buffer.byteLength(bytes)}\0${bytes}`)
      .digest("hex");
    const publishId = createContentPublicationId(
      `publish_${"5".repeat(32)}`,
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ token: "installation-token" }))
      .mockResolvedValueOnce(json({ object: { sha: expectedHead } }))
      .mockResolvedValueOnce(
        json({
          message: `Publish\n\nFoundry-Publish-Id: ${publishId}`,
          parents: [{ sha: expectedHead }],
        }),
      )
      .mockResolvedValueOnce(
        json({
          status: "ahead",
          ahead_by: 1,
          total_commits: 1,
          files: [
            {
              filename:
                "packages/site-definition/src/published-site.json",
              status: "modified",
              sha: blobSha,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(json({ object: { sha: commitSha } }));
    const publisher = createGitHubContentPublisher({
      configuration: { ...configurationInputs, privateKey },
      fetch: fetchMock,
    });

    await expect(
      publisher.retryReference({
        publishId,
        candidateCommitSha: commitSha,
        expectedHead,
        path: "packages/site-definition/src/published-site.json",
        bytes,
        assertLease: async () => true,
      }),
    ).resolves.toEqual({ state: "committed", commitSha });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://api.github.com/repos/client-owner/client-site/git/refs/heads/main",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ sha: commitSha, force: false }),
      }),
    );
  });

  it("uses the repository SHA-256 object format for retained blobs", async () => {
    const expectedHead = "a".repeat(64);
    const commitSha = "c".repeat(64);
    const bytes = "{}\n";
    const blobSha = createHash("sha256")
      .update(`blob ${Buffer.byteLength(bytes)}\0${bytes}`)
      .digest("hex");
    const publishId = createContentPublicationId(
      `publish_${"6".repeat(32)}`,
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ token: "installation-token" }))
      .mockResolvedValueOnce(json({ object: { sha: expectedHead } }))
      .mockResolvedValueOnce(
        json({
          message: `Publish\n\nFoundry-Publish-Id: ${publishId}`,
          parents: [{ sha: expectedHead }],
        }),
      )
      .mockResolvedValueOnce(
        json({
          status: "ahead",
          ahead_by: 1,
          total_commits: 1,
          files: [
            {
              filename:
                "packages/site-definition/src/published-site.json",
              status: "modified",
              sha: blobSha,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(json({ object: { sha: commitSha } }));
    const publisher = createGitHubContentPublisher({
      configuration: { ...configurationInputs, privateKey },
      fetch: fetchMock,
    });

    await expect(
      publisher.retryReference({
        publishId,
        candidateCommitSha: commitSha,
        expectedHead,
        path: "packages/site-definition/src/published-site.json",
        bytes,
        assertLease: async () => true,
      }),
    ).resolves.toEqual({ state: "committed", commitSha });
  });

  it("retains the candidate without advancing the ref after the lease is lost", async () => {
    const expectedHead = "a".repeat(40);
    const assertLease = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ token: "installation-token" }))
      .mockResolvedValueOnce(json({ object: { sha: expectedHead } }))
      .mockResolvedValueOnce(json({ tree: { sha: "base-tree-sha" } }))
      .mockResolvedValueOnce(json({ sha: "blob-sha" }))
      .mockResolvedValueOnce(json({ sha: "tree-sha" }))
      .mockResolvedValueOnce(json({ sha: "c".repeat(40) }));
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
        expectedHead,
        path: "packages/site-definition/src/published-site.json",
        bytes: "{}\n",
        message: "Publish",
        assertLease,
      }),
    ).resolves.toEqual({
      state: "unknown",
      detail: `git_reference_result_unknown:${"c".repeat(40)}`,
    });
    expect(assertLease).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH"),
    ).toBe(false);
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
          signal: expect.any(AbortSignal),
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

  it("keeps a release probe failure distinct from an observed mismatch", async () => {
    const expected = {
      commitSha: "c".repeat(40),
      contentHash: "d".repeat(64),
      schemaVersion: "1.0.0" as const,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ error: "temporarily unavailable" }, 503));
    const publisher = createGitHubContentPublisher({
      configuration: { ...configurationInputs, privateKey },
      fetch: fetchMock,
    });

    await expect(publisher.isReleaseLive(expected)).rejects.toThrow(
      "release_marker_unavailable",
    );
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

  it("reuses an unexpired installation token across status poll runtimes", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          token: "installation-token",
          expires_at: "2026-07-27T11:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(json({ check_runs: [] }))
      .mockResolvedValueOnce(json({ statuses: [] }))
      .mockResolvedValueOnce(json({ check_runs: [] }))
      .mockResolvedValueOnce(json({ statuses: [] }));
    const inputs = {
      configuration: { ...configurationInputs, privateKey },
      fetch: fetchMock,
      now: () => new Date("2026-07-27T10:00:00.000Z"),
    };

    await expect(
      createGitHubContentPublisher(inputs).getDeploymentStatus(
        "c".repeat(40),
      ),
    ).resolves.toBe("requested");
    await expect(
      createGitHubContentPublisher(inputs).getDeploymentStatus(
        "c".repeat(40),
      ),
    ).resolves.toBe("requested");

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("/access_tokens"),
      ),
    ).toHaveLength(1);
  });

  it("coalesces concurrent refreshes of an expired installation token", async () => {
    let currentTime = "2026-07-27T10:00:00.000Z";
    let tokenMints = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const requestUrl = String(url);
      if (requestUrl.includes("/access_tokens")) {
        tokenMints += 1;
        return json({
          token: `installation-token-${tokenMints}`,
          expires_at:
            tokenMints === 1
              ? "2026-07-27T10:02:00.000Z"
              : "2026-07-27T11:00:00.000Z",
        });
      }
      if (requestUrl.includes("/check-runs")) {
        return json({ check_runs: [] });
      }
      return json({ statuses: [] });
    });
    const inputs = {
      configuration: { ...configurationInputs, privateKey },
      fetch: fetchMock,
      now: () => new Date(currentTime),
    };

    await createGitHubContentPublisher(inputs).getDeploymentStatus(
      "c".repeat(40),
    );
    currentTime = "2026-07-27T10:02:00.000Z";
    await Promise.all([
      createGitHubContentPublisher(inputs).getDeploymentStatus(
        "c".repeat(40),
      ),
      createGitHubContentPublisher(inputs).getDeploymentStatus(
        "c".repeat(40),
      ),
    ]);

    expect(tokenMints).toBe(2);
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

  it("reconciles a retained candidate without a bounded history search", async () => {
    const publishId = createContentPublicationId(
      `publish_${"2".repeat(32)}`,
    );
    const candidateCommitSha = "c".repeat(40);
    const currentHead = "d".repeat(40);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ token: "installation-token" }))
      .mockResolvedValueOnce(
        json({
          sha: candidateCommitSha,
          message: `Publish\n\nFoundry-Publish-Id: ${publishId}`,
        }),
      )
      .mockResolvedValueOnce(json({ object: { sha: currentHead } }))
      .mockResolvedValueOnce(
        json({
          status: "ahead",
          merge_base_commit: { sha: candidateCommitSha },
        }),
      );
    const publisher = createGitHubContentPublisher({
      configuration: { ...configurationInputs, privateKey },
      fetch: fetchMock,
    });

    await expect(
      publisher.reconcileCommit(publishId, candidateCommitSha),
    ).resolves.toEqual({
      state: "committed",
      commitSha: candidateCommitSha,
    });
    expect(String(fetchMock.mock.calls[1]![0])).toContain(
      `/git/commits/${candidateCommitSha}`,
    );
    expect(String(fetchMock.mock.calls[3]![0])).toContain(
      `/compare/${candidateCommitSha}...${currentHead}`,
    );
  });
});
