import { SignJWT, importPKCS8 } from "jose";

import type {
  ContentPublisher,
  ContentPublicationId,
  PublicationCommitResult,
} from "@foundry/application";

export type GitHubContentPublisherConfiguration = Readonly<{
  appId: string;
  installationId: string;
  privateKey: string;
  owner: string;
  repository: string;
  productionBranch: string;
  publicOrigin: string;
  deploymentCheckName: string;
  cloudflareAccountId: string;
  cloudflareScriptTag: string;
  cloudflareBuildTriggerId: string;
  cloudflareApiToken: string;
}>;

export class GitHubContentPublisherConfigurationError extends Error {
  constructor() {
    super("github_content_publisher_not_configured");
    this.name = "GitHubContentPublisherConfigurationError";
  }
}

export type GitHubContentPublisherEnvironment = Readonly<{
  FOUNDRY_GITHUB_APP_ID?: string;
  FOUNDRY_GITHUB_INSTALLATION_ID?: string;
  FOUNDRY_GITHUB_PRIVATE_KEY?: string;
  FOUNDRY_GITHUB_OWNER?: string;
  FOUNDRY_GITHUB_REPOSITORY?: string;
  FOUNDRY_PRODUCTION_BRANCH?: string;
  FOUNDRY_PUBLIC_ORIGIN?: string;
  FOUNDRY_DEPLOYMENT_CHECK_NAME?: string;
  FOUNDRY_CLOUDFLARE_ACCOUNT_ID?: string;
  FOUNDRY_CLOUDFLARE_SCRIPT_TAG?: string;
  FOUNDRY_CLOUDFLARE_BUILD_TRIGGER_ID?: string;
  FOUNDRY_CLOUDFLARE_API_TOKEN?: string;
}>;

function requireValue(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new GitHubContentPublisherConfigurationError();
  }
  return value.trim();
}

export function readGitHubContentPublisherConfiguration(
  environment: GitHubContentPublisherEnvironment,
): GitHubContentPublisherConfiguration {
  const productionBranch =
    environment.FOUNDRY_PRODUCTION_BRANCH?.trim() || "main";
  if (!/^[A-Za-z0-9._/-]+$/u.test(productionBranch)) {
    throw new GitHubContentPublisherConfigurationError();
  }
  let publicOrigin: string;
  try {
    const parsedPublicOrigin = new URL(
      requireValue(environment.FOUNDRY_PUBLIC_ORIGIN),
    );
    if (parsedPublicOrigin.protocol !== "https:") {
      throw new GitHubContentPublisherConfigurationError();
    }
    publicOrigin = parsedPublicOrigin.origin;
  } catch {
    throw new GitHubContentPublisherConfigurationError();
  }
  return {
    appId: requireValue(environment.FOUNDRY_GITHUB_APP_ID),
    installationId: requireValue(
      environment.FOUNDRY_GITHUB_INSTALLATION_ID,
    ),
    privateKey: requireValue(environment.FOUNDRY_GITHUB_PRIVATE_KEY).replaceAll(
      "\\n",
      "\n",
    ),
    owner: requireValue(environment.FOUNDRY_GITHUB_OWNER),
    repository: requireValue(environment.FOUNDRY_GITHUB_REPOSITORY),
    productionBranch,
    publicOrigin,
    deploymentCheckName:
      environment.FOUNDRY_DEPLOYMENT_CHECK_NAME?.trim() || "Cloudflare",
    cloudflareAccountId: requireValue(
      environment.FOUNDRY_CLOUDFLARE_ACCOUNT_ID,
    ),
    cloudflareScriptTag: requireValue(
      environment.FOUNDRY_CLOUDFLARE_SCRIPT_TAG,
    ),
    cloudflareBuildTriggerId: requireValue(
      environment.FOUNDRY_CLOUDFLARE_BUILD_TRIGGER_ID,
    ),
    cloudflareApiToken: requireValue(
      environment.FOUNDRY_CLOUDFLARE_API_TOKEN,
    ),
  };
}

type GitHubFetch = typeof fetch;
type CachedInstallationToken = Readonly<{
  token: string;
  usableUntil: number;
}>;
const tokenCaches = new WeakMap<
  GitHubFetch,
  Map<string, Promise<CachedInstallationToken>>
>();

function githubHeaders(token: string) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
  };
}

async function readJson(response: Response): Promise<any> {
  const body: unknown = await response.json();
  if (!response.ok) {
    throw Object.assign(new Error("github_request_failed"), {
      status: response.status,
      responseMessage:
        typeof body === "object" &&
        body !== null &&
        "message" in body &&
        typeof body.message === "string"
          ? body.message
          : null,
    });
  }
  return body;
}

function isNonFastForwardRefError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error.status === 409 || error.status === 422) &&
    "responseMessage" in error &&
    typeof error.responseMessage === "string" &&
    /not a fast forward|non-fast-forward/iu.test(error.responseMessage)
  );
}

function isExplicitHttpRejection(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number" &&
    error.status >= 400 &&
    error.status < 500
  );
}

function sortedStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string").sort()
    : [];
}

function buildEnvironmentProjection(value: unknown) {
  if (typeof value !== "object" || value === null) {
    throw new Error("cloudflare_build_environment_invalid");
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => {
        if (typeof entry !== "object" || entry === null) {
          throw new Error("cloudflare_build_environment_invalid");
        }
        const variable = entry as Record<string, unknown>;
        const isSecret = variable.is_secret === true;
        return [
          key,
          {
            isSecret,
            value: isSecret ? null : variable.value,
            secretVersion: isSecret ? variable.created_on : null,
          },
        ];
      }),
  );
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function trailerMatches(message: unknown, publishId: ContentPublicationId) {
  return (
    typeof message === "string" &&
    message
      .split("\n")
      .some((line) => line === `Foundry-Publish-Id: ${publishId}`)
  );
}

export function createGitHubContentPublisher({
  configuration,
  fetch: fetchImplementation = fetch,
  now = () => new Date(),
}: {
  configuration: GitHubContentPublisherConfiguration;
  fetch?: GitHubFetch;
  now?: () => Date;
}): ContentPublisher {
  const repositoryPath =
    `/repos/${encodeURIComponent(configuration.owner)}` +
    `/${encodeURIComponent(configuration.repository)}`;
  const api = (path: string) => `https://api.github.com${path}`;
  const tokenCache =
    tokenCaches.get(fetchImplementation) ??
    new Map<string, Promise<CachedInstallationToken>>();
  tokenCaches.set(fetchImplementation, tokenCache);
  const tokenCacheKey = [
    configuration.appId,
    configuration.installationId,
    configuration.owner,
    configuration.repository,
  ].join(":");

  async function mintInstallationToken(
    current: Date,
  ): Promise<CachedInstallationToken> {
    const key = await importPKCS8(configuration.privateKey, "RS256");
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(configuration.appId)
      .setIssuedAt(Math.floor(current.getTime() / 1_000) - 60)
      .setExpirationTime(Math.floor(current.getTime() / 1_000) + 9 * 60)
      .sign(key);
    const response = await fetchImplementation(
      api(
        `/app/installations/${encodeURIComponent(
          configuration.installationId,
        )}/access_tokens`,
      ),
      {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
        headers: githubHeaders(jwt),
        body: JSON.stringify({
          repositories: [configuration.repository],
          permissions: {
            contents: "write",
            checks: "read",
            statuses: "read",
          },
        }),
      },
    );
    const body = await readJson(response);
    if (typeof body.token !== "string" || body.token === "") {
      throw new Error("github_installation_token_invalid");
    }
    const reportedExpiry =
      typeof body.expires_at === "string"
        ? Date.parse(body.expires_at)
        : Number.NaN;
    return {
      token: body.token,
      usableUntil: Number.isFinite(reportedExpiry)
        ? reportedExpiry - 60_000
        : current.getTime() + 5 * 60 * 1_000,
    };
  }

  async function installationToken(): Promise<string> {
    for (;;) {
      const current = now();
      const cachedPromise = tokenCache.get(tokenCacheKey);
      if (cachedPromise !== undefined) {
        try {
          const cached = await cachedPromise;
          if (cached.usableUntil > current.getTime()) {
            return cached.token;
          }
        } catch {
          // A failed mint is never retained.
        }
        if (tokenCache.get(tokenCacheKey) !== cachedPromise) {
          continue;
        }
        tokenCache.delete(tokenCacheKey);
      }
      if (tokenCache.has(tokenCacheKey)) {
        continue;
      }
      const mintedPromise = mintInstallationToken(current);
      tokenCache.set(tokenCacheKey, mintedPromise);
      try {
        return (await mintedPromise).token;
      } catch (error) {
        if (tokenCache.get(tokenCacheKey) === mintedPromise) {
          tokenCache.delete(tokenCacheKey);
        }
        throw error;
      }
    }
  }

  async function request(
    token: string,
    path: string,
    init: RequestInit = {},
  ) {
    return readJson(
      await fetchImplementation(api(`${repositoryPath}${path}`), {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(30_000),
        headers: {
          ...githubHeaders(token),
          ...init.headers,
        },
      }),
    );
  }

  async function productionHead(providedToken?: string) {
    const token = providedToken ?? (await installationToken());
    const body = await request(
      token,
      `/git/ref/heads/${configuration.productionBranch
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
    );
    if (typeof body.object?.sha !== "string") {
      throw new Error("github_production_head_invalid");
    }
    return body.object.sha as string;
  }

  async function readReleaseMarker(expected: {
    commitSha: string;
    contentHash: string;
    schemaVersion: string;
  }) {
    const markerUrl = new URL(
      "/.well-known/foundry-release.json",
      configuration.publicOrigin,
    );
    markerUrl.searchParams.set("foundry_probe", crypto.randomUUID());
    const response = await fetchImplementation(markerUrl, {
      headers: { "cache-control": "no-cache" },
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error("release_marker_unavailable");
    }
    const marker: unknown = await response.json();
    return (
      typeof marker === "object" &&
      marker !== null &&
      "commitSha" in marker &&
      marker.commitSha === expected.commitSha &&
      "contentHash" in marker &&
      marker.contentHash === expected.contentHash &&
      "schemaVersion" in marker &&
      marker.schemaVersion === expected.schemaVersion
    );
  }

  return {
    async getChannelConfigurationHash() {
      const root =
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
          configuration.cloudflareAccountId,
        )}/builds`;
      const requestOptions = {
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${configuration.cloudflareApiToken}`,
        },
      };
      const [triggersBody, environmentBody] = await Promise.all([
        fetchImplementation(
          `${root}/workers/${encodeURIComponent(
            configuration.cloudflareScriptTag,
          )}/triggers`,
          requestOptions,
        ).then(readJson),
        fetchImplementation(
          `${root}/triggers/${encodeURIComponent(
            configuration.cloudflareBuildTriggerId,
          )}/environment_variables`,
          requestOptions,
        ).then(readJson),
      ]);
      const trigger = Array.isArray(triggersBody.result)
        ? triggersBody.result.find(
            (candidate: any) =>
              candidate?.trigger_uuid ===
              configuration.cloudflareBuildTriggerId,
          )
        : undefined;
      if (
        typeof trigger !== "object" ||
        trigger === null ||
        trigger.external_script_id !== configuration.cloudflareScriptTag
      ) {
        throw new Error("cloudflare_build_configuration_invalid");
      }
      const repository = trigger.repo_connection;
      return sha256(
        JSON.stringify({
          appId: configuration.appId,
          installationId: configuration.installationId,
          owner: configuration.owner,
          repository: configuration.repository,
          productionBranch: configuration.productionBranch,
          publicOrigin: configuration.publicOrigin,
          deploymentCheckName: configuration.deploymentCheckName,
          cloudflareAccountId: configuration.cloudflareAccountId,
          cloudflareScriptTag: configuration.cloudflareScriptTag,
          cloudflareBuildTriggerId:
            configuration.cloudflareBuildTriggerId,
          buildConfiguration: {
            repository: {
              connectionId: repository?.repo_connection_uuid,
              providerType: repository?.provider_type,
              providerAccountId: repository?.provider_account_id,
              repositoryId: repository?.repo_id,
            },
            buildCommand: trigger.build_command,
            deployCommand: trigger.deploy_command,
            rootDirectory: trigger.root_directory,
            branchIncludes: sortedStrings(trigger.branch_includes),
            branchExcludes: sortedStrings(trigger.branch_excludes),
            pathIncludes: sortedStrings(trigger.path_includes),
            pathExcludes: sortedStrings(trigger.path_excludes),
            buildCachingEnabled: trigger.build_caching_enabled,
            environment: buildEnvironmentProjection(environmentBody.result),
          },
        }),
      );
    },
    getProductionHead() {
      return productionHead();
    },
    async isReleaseLive(expected) {
      return (
        (await readReleaseMarker(expected)) &&
        (await readReleaseMarker(expected))
      );
    },
    async createCommit(input): Promise<PublicationCommitResult> {
      let createdCommitSha: string | undefined;
      let gitSideEffectStarted = false;
      try {
        if (!(await input.assertLease())) {
          return { state: "blocked", detail: "publication_lease_lost" };
        }
        const token = await installationToken();
        if ((await productionHead(token)) !== input.expectedHead) {
          return { state: "blocked", detail: "production_head_moved" };
        }
        const baseCommit = await request(
          token,
          `/git/commits/${input.expectedHead}`,
        );
        if (typeof baseCommit.tree?.sha !== "string") {
          throw new Error("github_base_tree_invalid");
        }
        const blob = await request(token, "/git/blobs", {
          method: "POST",
          body: JSON.stringify({ content: input.bytes, encoding: "utf-8" }),
        });
        const tree = await request(token, "/git/trees", {
          method: "POST",
          body: JSON.stringify({
            base_tree: baseCommit.tree.sha,
            tree: [
              {
                path: input.path,
                mode: "100644",
                type: "blob",
                sha: blob.sha,
              },
            ],
          }),
        });
        gitSideEffectStarted = true;
        const commit = await request(token, "/git/commits", {
          method: "POST",
          body: JSON.stringify({
            message: input.message,
            tree: tree.sha,
            parents: [input.expectedHead],
          }),
        });
        if (typeof commit.sha !== "string") {
          throw new Error("github_commit_invalid");
        }
        createdCommitSha = commit.sha;
        if (!(await input.assertLease())) {
          return { state: "blocked", detail: "publication_lease_lost" };
        }
        try {
          await request(
            token,
            `/git/refs/heads/${configuration.productionBranch
              .split("/")
              .map(encodeURIComponent)
              .join("/")}`,
            {
              method: "PATCH",
              body: JSON.stringify({ sha: commit.sha, force: false }),
            },
          );
        } catch (error) {
          if (isNonFastForwardRefError(error)) {
            return { state: "blocked", detail: "production_head_moved" };
          }
          throw error;
        }
        return { state: "committed", commitSha: commit.sha };
      } catch (error) {
        if (!gitSideEffectStarted) {
          return { state: "failed", detail: "git_operation_failed" };
        }
        return {
          state: "unknown",
          detail:
            createdCommitSha === undefined
              ? "git_result_unknown"
              : `git_reference_result_unknown:${createdCommitSha}`,
        };
      }
    },
    async reconcileCommit(publishId, candidateCommitSha) {
      try {
        const token = await installationToken();
        if (candidateCommitSha !== undefined) {
          const candidate = await request(
            token,
            `/git/commits/${candidateCommitSha}`,
          );
          if (!trailerMatches(candidate.message, publishId)) {
            return { state: "not-found" };
          }
          const head = await productionHead(token);
          if (head === candidateCommitSha) {
            return { state: "committed", commitSha: candidateCommitSha };
          }
          const comparison = await request(
            token,
            `/compare/${candidateCommitSha}...${head}`,
          );
          return comparison.merge_base_commit?.sha === candidateCommitSha &&
            (comparison.status === "ahead" ||
              comparison.status === "identical")
            ? { state: "committed", commitSha: candidateCommitSha }
            : { state: "not-found" };
        }
        const commits = await request(
          token,
          `/commits?sha=${encodeURIComponent(
            configuration.productionBranch,
          )}&per_page=100`,
        );
        if (!Array.isArray(commits)) {
          return { state: "unknown" };
        }
        const match = commits.find((commit) =>
          trailerMatches(commit?.commit?.message, publishId),
        );
        return typeof match?.sha === "string"
          ? { state: "committed", commitSha: match.sha }
          : { state: "not-found" };
      } catch {
        return { state: "unknown" };
      }
    },
    async getDeploymentStatus(commitSha, deploymentId) {
      try {
        if (deploymentId !== undefined) {
          const response = await fetchImplementation(
            `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
              configuration.cloudflareAccountId,
            )}/builds/builds/${encodeURIComponent(deploymentId)}`,
            {
              signal: AbortSignal.timeout(30_000),
              headers: {
                authorization: `Bearer ${configuration.cloudflareApiToken}`,
              },
            },
          );
          const body = await readJson(response);
          const build = body.result;
          if (
            build?.status === "queued" ||
            build?.status === "initializing" ||
            build?.status === "running"
          ) {
            return "building";
          }
          if (build?.status === "stopped") {
            if (
              build.build_trigger_metadata?.commit_hash !== undefined &&
              build.build_trigger_metadata.commit_hash !== commitSha
            ) {
              return "failed";
            }
            return build.build_outcome === "success"
              ? "deployed"
              : ["fail", "skipped", "cancelled", "terminated"].includes(
                    build.build_outcome,
                  )
                ? "failed"
                : "unknown";
          }
          return "unknown";
        }
        const token = await installationToken();
        const [checks, statuses] = await Promise.all([
          request(token, `/commits/${commitSha}/check-runs?per_page=100`),
          request(token, `/commits/${commitSha}/status`),
        ]);
        const needle = configuration.deploymentCheckName.toLocaleLowerCase();
        const relevantCheck = Array.isArray(checks.check_runs)
          ? checks.check_runs.find(
              (check: any) =>
                typeof check.name === "string" &&
                check.name.toLocaleLowerCase() === needle,
            )
          : undefined;
        const relevantStatus = Array.isArray(statuses.statuses)
          ? statuses.statuses.find(
              (status: any) =>
                typeof status.context === "string" &&
                status.context.toLocaleLowerCase() === needle,
            )
          : undefined;
        if (
          (relevantCheck?.status === "completed" &&
            relevantCheck.conclusion !== "success") ||
          (relevantStatus !== undefined &&
            ["failure", "error"].includes(relevantStatus.state))
        ) {
          return "failed";
        }
        if (
          relevantCheck?.status === "in_progress" ||
          relevantStatus?.state === "pending"
        ) {
          return "building";
        }
        if (
          (relevantCheck?.status === "completed" &&
            relevantCheck.conclusion === "success") ||
          relevantStatus?.state === "success"
        ) {
          return "deployed";
        }
        return "requested";
      } catch {
        return "unknown";
      }
    },
    async retryDeployment(commitSha) {
      try {
        const response = await fetchImplementation(
          `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
            configuration.cloudflareAccountId,
          )}/builds/triggers/${encodeURIComponent(
            configuration.cloudflareBuildTriggerId,
          )}/builds`,
          {
            method: "POST",
            signal: AbortSignal.timeout(30_000),
            headers: {
              authorization: `Bearer ${configuration.cloudflareApiToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              branch: configuration.productionBranch,
              commit_hash: commitSha,
            }),
          },
        );
        const body = await readJson(response);
        return body.success === true &&
          typeof body.result?.build_uuid === "string"
          ? { state: "requested" as const, deploymentId: body.result.build_uuid }
          : { state: "failed" as const };
      } catch (error) {
        return isExplicitHttpRejection(error)
          ? { state: "failed" as const }
          : { state: "unknown" as const };
      }
    },
  };
}
