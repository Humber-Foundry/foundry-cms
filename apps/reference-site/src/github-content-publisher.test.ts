import { beforeAll, describe, expect, it, vi } from "vitest";
import { exportPKCS8, generateKeyPair } from "jose";
import { createHash, createHmac } from "node:crypto";

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
  cloudflareScriptName: "foundry-reference-site",
  cloudflareBuildTriggerId: "trigger-456",
  cloudflareApiToken: "cloudflare-api-token",
  publicationSigningSecret: "publication-signing-secret-32-bytes",
};

function publicationReconciliationInput(
  publishId: ReturnType<typeof createContentPublicationId>,
) {
  const bytes = "{\"schemaVersion\":\"1.0.0\"}\n";
  return {
    publishId,
    expectedHead: "a".repeat(40),
    path: "packages/site-definition/src/published-site.json" as const,
    artifactHash: createHash("sha256").update(bytes).digest("hex"),
    contentHash: "b".repeat(64),
    message: `Publish\n\nFoundry-Publish-Id: ${publishId}`,
  };
}

function signedPublicationMessage(
  input: ReturnType<typeof publicationReconciliationInput>,
) {
  return (
    `${input.message}\nFoundry-Publication-Signature: v1=` +
    createHmac(
      "sha256",
      configurationInputs.publicationSigningSecret,
    )
      .update(
        [
          "foundry-publication-signature-v1",
          input.expectedHead,
          input.path,
          input.contentHash,
          input.message,
        ].join("\0"),
      )
      .digest("hex")
  );
}

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
        FOUNDRY_CLOUDFLARE_SCRIPT_NAME: "foundry-reference-site",
        FOUNDRY_CLOUDFLARE_BUILD_TRIGGER_ID: "trigger-456",
        FOUNDRY_CLOUDFLARE_API_TOKEN: "cloudflare-api-token",
        FOUNDRY_PUBLICATION_SIGNING_SECRET:
          "publication-signing-secret-32-bytes",
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
        FOUNDRY_CLOUDFLARE_SCRIPT_NAME: "foundry-reference-site",
        FOUNDRY_CLOUDFLARE_BUILD_TRIGGER_ID: "trigger-456",
        FOUNDRY_CLOUDFLARE_API_TOKEN: "cloudflare-api-token",
        FOUNDRY_PUBLICATION_SIGNING_SECRET:
          "publication-signing-secret-32-bytes",
      }),
    ).toThrow(GitHubContentPublisherConfigurationError);

    for (const invalidBranch of [
      "main/../release",
      "../main",
      "main//release",
      "/main",
      "main/",
      ".hidden",
      "release.lock",
      "-main",
      "HEAD",
    ]) {
      expect(() =>
        readGitHubContentPublisherConfiguration({
          FOUNDRY_GITHUB_APP_ID: "123",
          FOUNDRY_GITHUB_INSTALLATION_ID: "456",
          FOUNDRY_GITHUB_PRIVATE_KEY: "private-key",
          FOUNDRY_GITHUB_OWNER: "client-owner",
          FOUNDRY_GITHUB_REPOSITORY: "client-site",
          FOUNDRY_PRODUCTION_BRANCH: invalidBranch,
          FOUNDRY_PUBLIC_ORIGIN: "https://site.example",
          FOUNDRY_CLOUDFLARE_ACCOUNT_ID: "account-123",
          FOUNDRY_CLOUDFLARE_SCRIPT_TAG: "script-789",
          FOUNDRY_CLOUDFLARE_SCRIPT_NAME: "foundry-reference-site",
          FOUNDRY_CLOUDFLARE_BUILD_TRIGGER_ID: "trigger-456",
          FOUNDRY_CLOUDFLARE_API_TOKEN: "cloudflare-api-token",
          FOUNDRY_PUBLICATION_SIGNING_SECRET:
            "publication-signing-secret-32-bytes",
        }),
      ).toThrow(GitHubContentPublisherConfigurationError);
    }
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
            "Publish\n\nFoundry-Publish-Id: publish_11111111111111111111111111111111\n" +
            `Foundry-Publication-Signature: v1=${createHmac(
              "sha256",
              configurationInputs.publicationSigningSecret,
            )
              .update(
                [
                  "foundry-publication-signature-v1",
                  expectedHead,
                  "packages/site-definition/src/published-site.json",
                  "b".repeat(64),
                  "Publish\n\nFoundry-Publish-Id: publish_11111111111111111111111111111111",
                ].join("\0"),
              )
              .digest("hex")}`,
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

  it("keeps an ambiguous commit HTTP response unknown for reconciliation", async () => {
    const expectedHead = "a".repeat(40);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ token: "installation-token" }))
      .mockResolvedValueOnce(json({ object: { sha: expectedHead } }))
      .mockResolvedValueOnce(json({ tree: { sha: "base-tree-sha" } }))
      .mockResolvedValueOnce(json({ sha: "blob-sha" }))
      .mockResolvedValueOnce(json({ sha: "tree-sha" }))
      .mockResolvedValueOnce(json({ message: "Request Timeout" }, 408));
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
          branch_includes: ["*"],
          branch_excludes: ["release/*"],
          path_includes: ["packages/site-definition/*"],
          path_excludes: [],
          build_caching_enabled: true,
          repo_connection: {
            repo_connection_uuid: "connection-1",
            provider_type: "github",
            provider_account_id: "account-owner",
            provider_account_name: "client-owner",
            repo_id: "repository-1",
            repo_name: "client-site",
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
      result_info: { page: 1, total_pages: 1 },
    };
    const configurationFetch = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) =>
        json(
          String(input).includes("/environment_variables?")
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
    const differentWorkerPublisher = createGitHubContentPublisher({
      configuration: {
        ...configurationInputs,
        privateKey,
        cloudflareScriptName: "another-reference-site",
      },
      fetch: configurationFetch,
    });
    const changedBuildPublisher = createGitHubContentPublisher({
      configuration: { ...configurationInputs, privateKey },
      fetch: vi
        .fn<typeof fetch>()
        .mockImplementation(async (input) =>
          json(
            String(input).includes("/environment_variables?")
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
    const publisherForBuildTrigger = (trigger: Record<string, unknown>) =>
      createGitHubContentPublisher({
        configuration: { ...configurationInputs, privateKey },
        fetch: vi
          .fn<typeof fetch>()
          .mockImplementation(async (input) =>
            json(
              String(input).includes("/environment_variables?")
                ? environmentConfiguration
                : { ...buildConfiguration, result: [trigger] },
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
      differentWorkerPublisher.getChannelConfigurationHash(),
    ).resolves.not.toBe(
      await publisher.getChannelConfigurationHash(),
    );
    await expect(
      changedBuildPublisher.getChannelConfigurationHash(),
    ).rejects.toThrow("cloudflare_build_configuration_invalid");
    await expect(
      publisherForBuildTrigger({
        ...buildConfiguration.result[0],
        repo_connection: {
          ...buildConfiguration.result[0].repo_connection,
          repo_name: "another-site",
        },
      }).getChannelConfigurationHash(),
    ).rejects.toThrow("cloudflare_build_configuration_invalid");
    await expect(
      publisherForBuildTrigger({
        ...buildConfiguration.result[0],
        branch_includes: ["preview/*"],
        branch_excludes: [],
      }).getChannelConfigurationHash(),
    ).rejects.toThrow("cloudflare_build_configuration_invalid");
    await expect(
      publisherForBuildTrigger({
        ...buildConfiguration.result[0],
        branch_includes: ["*"],
        branch_excludes: ["main"],
      }).getChannelConfigurationHash(),
    ).rejects.toThrow("cloudflare_build_configuration_invalid");
    await expect(
      publisherForBuildTrigger({
        ...buildConfiguration.result[0],
        path_includes: ["docs/*"],
        path_excludes: [],
      }).getChannelConfigurationHash(),
    ).rejects.toThrow("cloudflare_build_configuration_invalid");
    await expect(
      publisherForBuildTrigger({
        ...buildConfiguration.result[0],
        path_includes: ["*"],
        path_excludes: ["packages/site-definition/*"],
      }).getChannelConfigurationHash(),
    ).rejects.toThrow("cloudflare_build_configuration_invalid");
    await expect(
      publisherForBuildTrigger({
        ...buildConfiguration.result[0],
        path_includes: ["*"],
        path_excludes: ["packages/*/published-site.json"],
      }).getChannelConfigurationHash(),
    ).rejects.toThrow("cloudflare_build_configuration_invalid");

    const pagedEnvironmentFetch = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (!url.pathname.endsWith("/environment_variables")) {
          return json(buildConfiguration);
        }
        return url.searchParams.get("page") === "1"
          ? json({
              success: true,
              result: {
                NODE_ENV: {
                  is_secret: false,
                  value: "production",
                  created_on: "2026-07-27T00:00:00Z",
                },
              },
              result_info: { page: 1, total_pages: 2 },
            })
          : json({
              success: true,
              result: {
                DEPLOY_TOKEN: {
                  is_secret: true,
                  value: null,
                  created_on: "2026-07-28T00:00:00Z",
                },
              },
              result_info: { page: 2, total_pages: 2 },
            });
      });
    const pagedPublisher = createGitHubContentPublisher({
      configuration: { ...configurationInputs, privateKey },
      fetch: pagedEnvironmentFetch,
    });
    await expect(
      pagedPublisher.getChannelConfigurationHash(),
    ).resolves.not.toBe(await publisher.getChannelConfigurationHash());
    expect(
      pagedEnvironmentFetch.mock.calls.filter(([input]) =>
        String(input).includes("/environment_variables?"),
      ),
    ).toHaveLength(2);

    const malformedEnvironmentPublisher = (
      variable: Record<string, unknown>,
    ) =>
      createGitHubContentPublisher({
        configuration: { ...configurationInputs, privateKey },
        fetch: vi.fn<typeof fetch>().mockImplementation(async (input) =>
          json(
            String(input).includes("/environment_variables?")
              ? {
                  success: true,
                  result: { INVALID: variable },
                  result_info: { page: 1, total_pages: 1 },
                }
              : buildConfiguration,
          ),
        ),
      });
    for (const malformed of [
      { value: "missing-secret-flag" },
      { is_secret: "false", value: "wrong-flag-type" },
      { is_secret: false, value: null },
      { is_secret: true, value: null },
      { is_secret: true, value: null, created_on: "not-a-date" },
    ]) {
      await expect(
        malformedEnvironmentPublisher(
          malformed,
        ).getChannelConfigurationHash(),
      ).rejects.toThrow("cloudflare_build_environment_invalid");
    }

    const rotatedEnvironment = {
      ...environmentConfiguration,
      result: {
        ...environmentConfiguration.result,
        DEPLOY_TOKEN: {
          ...environmentConfiguration.result.DEPLOY_TOKEN,
          created_on: "2026-07-28T00:00:00Z",
        },
      },
    };
    const secretRotatedPublisher = createGitHubContentPublisher({
      configuration: { ...configurationInputs, privateKey },
      fetch: vi.fn<typeof fetch>().mockImplementation(async (input) =>
        json(
          String(input).includes("/environment_variables?")
            ? rotatedEnvironment
            : buildConfiguration,
        ),
      ),
    });
    await expect(
      secretRotatedPublisher.getChannelConfigurationHash(),
    ).resolves.not.toBe(await publisher.getChannelConfigurationHash());
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
      publisher.retryDeployment({
        commitSha: "c".repeat(40),
        assertDispatch: vi.fn().mockResolvedValue(true),
      }),
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

  it.each([408, 425, 429, 499])(
    "keeps an ambiguous Cloudflare build response (%s) unknown",
    async (status) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ message: "ambiguous write response" }, status));
      const publisher = createGitHubContentPublisher({
        configuration: { ...configurationInputs, privateKey },
        fetch: fetchMock,
      });

      await expect(
        publisher.retryDeployment({
          commitSha: "c".repeat(40),
          assertDispatch: vi.fn().mockResolvedValue(true),
        }),
      ).resolves.toEqual({ state: "unknown" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("does not contact Cloudflare after losing the exact retry claim", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const assertDispatch = vi.fn().mockResolvedValue(false);
    const publisher = createGitHubContentPublisher({
      configuration: { ...configurationInputs, privateKey },
      fetch: fetchMock,
    });

    await expect(
      publisher.retryDeployment({
        commitSha: "c".repeat(40),
        assertDispatch,
      }),
    ).resolves.toEqual({
      state: "blocked",
      detail: "deployment_retry_claim_lost",
    });

    expect(assertDispatch).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
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

  it("preserves an exact candidate after an ambiguous ref HTTP response", async () => {
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
      .mockResolvedValueOnce(json({ message: "Too Early" }, 425));
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

  it("reconciles an exact retained commit that already advanced the ref", async () => {
    const expectedHead = "a".repeat(40);
    const commitSha = "c".repeat(40);
    const bytes = "{}\n";
    const blobSha = createHash("sha1")
      .update(`blob ${Buffer.byteLength(bytes)}\0${bytes}`)
      .digest("hex");
    const publishId = createContentPublicationId(
      `publish_${"7".repeat(32)}`,
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ token: "installation-token" }))
      .mockResolvedValueOnce(json({ object: { sha: commitSha } }))
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
      );
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
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH"),
    ).toBe(false);
  });

  it("rejects an invalid retained commit even when it is already the ref head", async () => {
    const expectedHead = "a".repeat(40);
    const commitSha = "c".repeat(40);
    const bytes = "{}\n";
    const blobSha = createHash("sha1")
      .update(`blob ${Buffer.byteLength(bytes)}\0${bytes}`)
      .digest("hex");
    const publishId = createContentPublicationId(
      `publish_${"8".repeat(32)}`,
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ token: "installation-token" }))
      .mockResolvedValueOnce(json({ object: { sha: commitSha } }))
      .mockResolvedValueOnce(
        json({
          message: "Publish\n\nFoundry-Publish-Id: publish_other",
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
      );
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
    ).resolves.toEqual({
      state: "failed",
      detail: "git_reference_candidate_invalid",
    });
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH"),
    ).toBe(false);
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
          redirect: "manual",
          signal: expect.any(AbortSignal),
        }),
      );
    }
  });

  it("rejects a redirected runtime release marker", async () => {
    const expected = {
      commitSha: "c".repeat(40),
      contentHash: "d".repeat(64),
      schemaVersion: "1.0.0" as const,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location: "https://other.example/marker.json" },
        }),
      );
    const publisher = createGitHubContentPublisher({
      configuration: { ...configurationInputs, privateKey },
      fetch: fetchMock,
    });

    await expect(publisher.isReleaseLive(expected)).rejects.toThrow(
      "release_marker_unavailable",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ redirect: "manual" }),
    );
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

  it("rejects a copied trailer and reconciles the exact signed publication commit", async () => {
    const publishId = createContentPublicationId(
      `publish_${"1".repeat(32)}`,
    );
    const input = publicationReconciliationInput(publishId);
    const copiedCommitSha = "d".repeat(40);
    const exactCommitSha = "c".repeat(40);
    const fileSha = "f".repeat(40);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ token: "installation-token" }))
      .mockResolvedValueOnce(
        json([
          {
            sha: copiedCommitSha,
            commit: {
              message: signedPublicationMessage(input),
            },
          },
          {
            sha: exactCommitSha,
            commit: {
              message: input.message,
            },
          },
        ]),
      )
      .mockResolvedValueOnce(
        json({
          sha: copiedCommitSha,
          message: signedPublicationMessage(input),
          parents: [{ sha: exactCommitSha }],
        }),
      )
      .mockResolvedValueOnce(
        json({
          status: "ahead",
          ahead_by: 2,
          total_commits: 2,
          files: [
            {
              filename: "apps/reference-site/app/page.tsx",
              status: "modified",
              sha: fileSha,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        json({
          sha: exactCommitSha,
          message: `${signedPublicationMessage(input)}\n`,
          parents: [{ sha: input.expectedHead }],
        }),
      )
      .mockResolvedValueOnce(
        json({
          status: "ahead",
          ahead_by: 1,
          total_commits: 1,
          files: [
            {
              filename: input.path,
              status: "modified",
              sha: fileSha,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        json({
          encoding: "base64",
          content: Buffer.from(
            "{\"schemaVersion\":\"1.0.0\"}\n",
          ).toString("base64"),
        }),
      );
    const publisher = createGitHubContentPublisher({
      configuration: { ...configurationInputs, privateKey },
      fetch: fetchMock,
    });

    await expect(publisher.reconcileCommit(input)).resolves.toEqual({
      state: "committed",
      commitSha: exactCommitSha,
    });
    expect(String(fetchMock.mock.calls[2]![0])).toContain(
      `/git/commits/${copiedCommitSha}`,
    );
    expect(String(fetchMock.mock.calls[4]![0])).toContain(
      `/git/commits/${exactCommitSha}`,
    );
  });

  it("reconciles a retained candidate without a bounded history search", async () => {
    const publishId = createContentPublicationId(
      `publish_${"2".repeat(32)}`,
    );
    const candidateCommitSha = "c".repeat(40);
    const currentHead = "d".repeat(40);
    const input = {
      ...publicationReconciliationInput(publishId),
      candidateCommitSha,
    };
    const fileSha = "f".repeat(40);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ token: "installation-token" }))
      .mockResolvedValueOnce(
        json({
          sha: candidateCommitSha,
          message: signedPublicationMessage(input),
          parents: [{ sha: input.expectedHead }],
        }),
      )
      .mockResolvedValueOnce(
        json({
          status: "ahead",
          ahead_by: 1,
          total_commits: 1,
          files: [
            {
              filename: input.path,
              status: "modified",
              sha: fileSha,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        json({
          encoding: "base64",
          content: Buffer.from(
            "{\"schemaVersion\":\"1.0.0\"}\n",
          ).toString("base64"),
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
      publisher.reconcileCommit(input),
    ).resolves.toEqual({
      state: "committed",
      commitSha: candidateCommitSha,
    });
    expect(String(fetchMock.mock.calls[1]![0])).toContain(
      `/git/commits/${candidateCommitSha}`,
    );
    expect(String(fetchMock.mock.calls[5]![0])).toContain(
      `/compare/${candidateCommitSha}...${currentHead}`,
    );
  });
});
