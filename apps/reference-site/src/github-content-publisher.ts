import { SignJWT, importPKCS8 } from "jose";

import type {
  ContentPublicationArtifact,
  CampaignBulkArtifactPublisher,
  ContentPublisher,
  ContentPublicationId,
  ContentPublishedRevisionReader,
  ContentSerializationVersion,
  PublicationCommitResult,
} from "@foundry/application";
import {
  hashContentPublicationArtifacts,
  isValidGitBranchName,
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
  cloudflareScriptName: string;
  cloudflareBuildTriggerId: string;
  cloudflareApiToken: string;
  publicationSigningSecret: string;
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
  FOUNDRY_CLOUDFLARE_SCRIPT_NAME?: string;
  FOUNDRY_CLOUDFLARE_BUILD_TRIGGER_ID?: string;
  FOUNDRY_CLOUDFLARE_API_TOKEN?: string;
  FOUNDRY_PUBLICATION_SIGNING_SECRET?: string;
}>;

function requireValue(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new GitHubContentPublisherConfigurationError();
  }
  return value.trim();
}

function requireSigningSecret(value: string | undefined): string {
  const secret = requireValue(value);
  if (new TextEncoder().encode(secret).byteLength < 32) {
    throw new GitHubContentPublisherConfigurationError();
  }
  return secret;
}

export function readGitHubContentPublisherConfiguration(
  environment: GitHubContentPublisherEnvironment,
): GitHubContentPublisherConfiguration {
  const productionBranch =
    environment.FOUNDRY_PRODUCTION_BRANCH?.trim() || "main";
  if (!isValidGitBranchName(productionBranch)) {
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
    cloudflareScriptName: requireValue(
      environment.FOUNDRY_CLOUDFLARE_SCRIPT_NAME,
    ),
    cloudflareBuildTriggerId: requireValue(
      environment.FOUNDRY_CLOUDFLARE_BUILD_TRIGGER_ID,
    ),
    cloudflareApiToken: requireValue(
      environment.FOUNDRY_CLOUDFLARE_API_TOKEN,
    ),
    publicationSigningSecret: requireSigningSecret(
      environment.FOUNDRY_PUBLICATION_SIGNING_SECRET,
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
const maximumPublishedArtifactBytes = 16 * 1024 * 1024;

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

function isExpectedHeadMismatch(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "responseMessage" in error &&
    typeof error.responseMessage === "string" &&
    /expected.?head|head oid|expected.*branch|expected.*oid|branch.*point|branch.*updated|branch.*changed/iu.test(
      error.responseMessage,
    )
  );
}

const definiteGraphQlMutationErrorCodes = new Set([
  "BAD_USER_INPUT",
  "UNPROCESSABLE",
  "VALIDATION_FAILED",
]);

function isDefiniteGraphQlMutationRejection(error: unknown) {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const message =
    "message" in error && typeof error.message === "string"
      ? error.message
      : "";
  const directCode =
    "type" in error && typeof error.type === "string"
      ? error.type
      : null;
  const extensionCode =
    "extensions" in error &&
    typeof error.extensions === "object" &&
    error.extensions !== null &&
    "code" in error.extensions &&
    typeof error.extensions.code === "string"
      ? error.extensions.code
      : null;
  const structuredCode = directCode ?? extensionCode;
  if (structuredCode !== null) {
    return definiteGraphQlMutationErrorCodes.has(structuredCode);
  }
  return (
    isExpectedHeadMismatch({ responseMessage: message }) ||
    /\bvalidation failed\b/iu.test(message)
  );
}

const ambiguousWriteResponseStatuses = new Set([408, 425, 429, 499]);

function isDefiniteHttpRejection(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number" &&
    error.status >= 400 &&
    error.status < 500 &&
    !ambiguousWriteResponseStatuses.has(error.status)
  );
}

function sortedStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string").sort()
    : [];
}

function isDocumentedCloudflareWatchPattern(pattern: string) {
  if (pattern === "") {
    return false;
  }
  const wildcardIndexes = [...pattern.matchAll(/\*/gu)].map(
    (match) => match.index,
  );
  return !wildcardIndexes.some(
    (index) => index !== 0 && index !== pattern.length - 1,
  );
}

function matchesCloudflareWatchPattern(pattern: string, value: string) {
  const startsWithWildcard = pattern.startsWith("*");
  const endsWithWildcard = pattern.endsWith("*");
  const literal = pattern.slice(
    startsWithWildcard ? 1 : 0,
    endsWithWildcard ? -1 : undefined,
  );
  const escapedLiteral = literal.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `^${startsWithWildcard ? ".*" : ""}${escapedLiteral}${
      endsWithWildcard ? ".*" : ""
    }$`,
    "u",
  ).test(value);
}

function cloudflareWatchFilterAllows(
  value: string,
  includes: unknown,
  excludes: unknown,
) {
  if (
    !Array.isArray(includes) ||
    !includes.every((entry): entry is string => typeof entry === "string") ||
    !Array.isArray(excludes) ||
    !excludes.every((entry): entry is string => typeof entry === "string") ||
    !includes.every(isDocumentedCloudflareWatchPattern) ||
    !excludes.every(isDocumentedCloudflareWatchPattern)
  ) {
    return false;
  }
  // Workers Builds ignores exclusions first, then requires one include match.
  return (
    !excludes.some((pattern) =>
      matchesCloudflareWatchPattern(pattern, value),
    ) &&
    includes.some((pattern) => matchesCloudflareWatchPattern(pattern, value))
  );
}

function buildEnvironmentProjection(value: unknown) {
  if (typeof value !== "object" || value === null) {
    throw new Error("cloudflare_build_environment_invalid");
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => {
        if (
          key.trim() === "" ||
          typeof entry !== "object" ||
          entry === null
        ) {
          throw new Error("cloudflare_build_environment_invalid");
        }
        const variable = entry as Record<string, unknown>;
        if (typeof variable.is_secret !== "boolean") {
          throw new Error("cloudflare_build_environment_invalid");
        }
        const isSecret = variable.is_secret;
        if (
          (isSecret &&
            (typeof variable.created_on !== "string" ||
              variable.created_on.trim() === "" ||
              !Number.isFinite(Date.parse(variable.created_on)))) ||
          (!isSecret && typeof variable.value !== "string")
        ) {
          throw new Error("cloudflare_build_environment_invalid");
        }
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
  return sha256Bytes(new TextEncoder().encode(value));
}

async function sha256Bytes(value: Uint8Array) {
  const bytes = new Uint8Array(value.byteLength);
  bytes.set(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function encodeBase64Utf8(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

function publicationSignaturePayload(input: {
  expectedHead: string;
  serializationVersion: ContentSerializationVersion;
  path: string;
  artifactHash: string;
  contentHash: string;
  message: string;
}) {
  return input.serializationVersion ===
    "foundry.site-definition.canonical-json.v1"
    ? [
        "foundry-publication-signature-v1",
        input.expectedHead,
        input.path,
        input.contentHash,
        input.message,
      ].join("\0")
    : [
        "foundry-publication-signature-v2",
        input.expectedHead,
        input.artifactHash,
        input.contentHash,
        input.message,
      ].join("\0");
}

async function signPublicationMessage(
  secret: string,
  input: {
    expectedHead: string;
    serializationVersion: ContentSerializationVersion;
    path: string;
    artifactHash: string;
    contentHash: string;
    message: string;
  },
) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(publicationSignaturePayload(input)),
  );
  const hex = [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const version =
    input.serializationVersion ===
    "foundry.site-definition.canonical-json.v1"
      ? "v1"
      : "v2";
  return `${input.message}\nFoundry-Publication-Signature: ${version}=${hex}`;
}

async function gitBlobSha(value: string, repositoryObjectId: string) {
  const bytes = new TextEncoder().encode(value);
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const payload = new Uint8Array(header.byteLength + bytes.byteLength);
  payload.set(header);
  payload.set(bytes, header.byteLength);
  const algorithm =
    repositoryObjectId.length === 40
      ? "SHA-1"
      : repositoryObjectId.length === 64
        ? "SHA-256"
        : null;
  if (algorithm === null) {
    throw new Error("github_object_format_invalid");
  }
  const digest = await crypto.subtle.digest(algorithm, payload);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const managedRichTextArtifactPathPattern =
  /^content\/rich-text\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.md$/u;

function gitTreeBlobs(value: unknown): ReadonlyMap<string, string> {
  if (
    typeof value !== "object" ||
    value === null ||
    ("truncated" in value && value.truncated === true) ||
    !("tree" in value) ||
    !Array.isArray(value.tree)
  ) {
    throw new Error("github_tree_invalid");
  }
  const blobs = new Map<string, string>();
  for (const entry of value.tree) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("type" in entry) ||
      entry.type !== "blob"
    ) {
      continue;
    }
    if (
      !("path" in entry) ||
      typeof entry.path !== "string" ||
      !("sha" in entry) ||
      typeof entry.sha !== "string" ||
      blobs.has(entry.path)
    ) {
      throw new Error("github_tree_invalid");
    }
    blobs.set(entry.path, entry.sha);
  }
  return blobs;
}

function publicationCandidateMatches({
  artifacts,
  candidateBlobs,
  expectedBlobShas,
  files,
}: {
  artifacts: ReadonlyArray<ContentPublicationArtifact>;
  candidateBlobs: ReadonlyMap<string, string>;
  expectedBlobShas: ReadonlyArray<string>;
  files: ReadonlyArray<any>;
}) {
  const expectedArtifacts = new Map(
    artifacts.map((artifact, index) => [
      artifact.path,
      expectedBlobShas[index]!,
    ]),
  );
  const candidateManagedPaths = [...candidateBlobs.keys()]
    .filter((path) => managedRichTextArtifactPathPattern.test(path))
    .sort();
  const expectedManagedPaths = artifacts
    .map(({ path }) => path)
    .filter((path) => managedRichTextArtifactPathPattern.test(path))
    .sort();
  if (
    candidateManagedPaths.join("\0") !== expectedManagedPaths.join("\0") ||
    ![...expectedArtifacts].every(
      ([path, sha]) => candidateBlobs.get(path) === sha,
    )
  ) {
    return false;
  }
  const seenFiles = new Set<string>();
  return files.every((file) => {
    if (
      typeof file?.filename !== "string" ||
      seenFiles.has(file.filename)
    ) {
      return false;
    }
    seenFiles.add(file.filename);
    const expectedSha = expectedArtifacts.get(file.filename);
    if (
      expectedSha !== undefined &&
      (file.status === "added" || file.status === "modified") &&
      file.sha === expectedSha
    ) {
      return true;
    }
    if (
      expectedSha !== undefined &&
      file.status === "renamed" &&
      file.sha === expectedSha &&
      typeof file.previous_filename === "string" &&
      managedRichTextArtifactPathPattern.test(file.previous_filename)
    ) {
      return true;
    }
    return (
      expectedSha === undefined &&
      managedRichTextArtifactPathPattern.test(file.filename) &&
      file.status === "removed"
    );
  });
}

function trailerMatches(message: unknown, publishId: ContentPublicationId) {
  return (
    typeof message === "string" &&
    message
      .split("\n")
      .some((line) => line === `Foundry-Publish-Id: ${publishId}`)
  );
}

function normalizeCommitMessage(message: unknown) {
  return typeof message === "string"
    ? message.replace(/(?:\r?\n)+$/u, "")
    : null;
}

export function createGitHubContentPublisher({
  configuration,
  fetch: fetchImplementation = fetch,
  now = () => new Date(),
}: {
  configuration: GitHubContentPublisherConfiguration;
  fetch?: GitHubFetch;
  now?: () => Date;
}): ContentPublisher &
  ContentPublishedRevisionReader &
  CampaignBulkArtifactPublisher {
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

  async function requestRaw(token: string, path: string) {
    const response = await fetchImplementation(
      api(`${repositoryPath}${path}`),
      {
        signal: AbortSignal.timeout(30_000),
        headers: {
          ...githubHeaders(token),
          accept: "application/vnd.github.raw+json",
        },
      },
    );
    if (!response.ok) {
      await readJson(response);
    }
    const contentLength = response.headers.get("content-length");
    const reportedLength =
      contentLength === null ? null : Number(contentLength);
    if (
      reportedLength !== null &&
      Number.isFinite(reportedLength) &&
      reportedLength > maximumPublishedArtifactBytes
    ) {
      await response.body?.cancel();
      return null;
    }
    if (response.body === null) {
      return new Uint8Array();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        byteLength += chunk.value.byteLength;
        if (byteLength > maximumPublishedArtifactBytes) {
          await reader.cancel();
          return null;
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  async function graphqlRequest(
    token: string,
    query: string,
    variables: Record<string, unknown>,
  ) {
    const body = await readJson(
      await fetchImplementation("https://api.github.com/graphql", {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
        headers: githubHeaders(token),
        body: JSON.stringify({ query, variables }),
      }),
    );
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      const errors = body.errors as unknown[];
      const message = errors
        .map((error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof error.message === "string"
            ? error.message
            : "GraphQL mutation failed",
        )
        .join("; ");
      throw Object.assign(new Error("github_graphql_request_failed"), {
        status: errors.every(isDefiniteGraphQlMutationRejection)
          ? 422
          : 500,
        responseMessage: message,
      });
    }
    return body;
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

  async function commitMatchesExactPublication(
    token: string,
    commitSha: string,
    input: Parameters<ContentPublisher["reconcileCommit"]>[0],
    signedMessage: string,
  ) {
    const artifacts = [...input.artifacts].sort(
      ({ path: left }, { path: right }) => left.localeCompare(right),
    );
    const legacyArtifact =
      input.serializationVersion ===
        "foundry.site-definition.canonical-json.v1" &&
      artifacts.length === 1 &&
      artifacts[0]?.path ===
        "packages/site-definition/src/published-site.json"
        ? artifacts[0]
        : null;
    if (
      input.serializationVersion ===
      "foundry.site-definition.canonical-json.v1"
    ) {
      if (
        legacyArtifact === null ||
        (await sha256(legacyArtifact.bytes)) !== input.artifactHash
      ) {
        return false;
      }
    } else if (
      (await hashContentPublicationArtifacts(artifacts)) !==
      input.artifactHash
    ) {
      return false;
    }
    const [candidate, comparison] = await Promise.all([
      request(token, `/git/commits/${commitSha}`),
      request(
        token,
        `/compare/${input.expectedHead}...${commitSha}`,
      ),
    ]);
    const parents = Array.isArray(candidate.parents) ? candidate.parents : [];
    const files = Array.isArray(comparison.files) ? comparison.files : [];
    if (
      normalizeCommitMessage(candidate.message) !== signedMessage ||
      parents.length !== 1 ||
      parents[0]?.sha !== input.expectedHead ||
      comparison.status !== "ahead" ||
      comparison.ahead_by !== 1 ||
      comparison.total_commits !== 1 ||
      files.length >= 300
    ) {
      return false;
    }
    if (legacyArtifact !== null) {
      if (
        files.length !== 1 ||
        files[0]?.filename !== legacyArtifact.path ||
        files[0]?.status !== "modified" ||
        typeof files[0]?.sha !== "string"
      ) {
        return false;
      }
      const blob = await requestRaw(
        token,
        `/git/blobs/${files[0].sha}`,
      );
      return (
        blob !== null &&
        (await sha256Bytes(blob)) === input.artifactHash
      );
    }
    if (typeof candidate.tree?.sha !== "string") {
      return false;
    }
    const expectedBlobShas = await Promise.all(
      artifacts.map(({ bytes }) =>
        gitBlobSha(bytes, input.expectedHead),
      ),
    );
    const candidateBlobs = gitTreeBlobs(
      await request(
        token,
        `/git/trees/${candidate.tree.sha}?recursive=1`,
      ),
    );
    return publicationCandidateMatches({
      artifacts,
      candidateBlobs,
      expectedBlobShas,
      files,
    });
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
      redirect: "manual",
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

  function campaignSendArtifactPath(operationId: string) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        operationId,
      )
    ) {
      throw new Error("campaign_send_operation_id_invalid");
    }
    return `content/campaign-sends/${operationId}.json`;
  }

  async function campaignSendCommitMatches({
    token,
    commitSha,
    path,
    message,
    input,
  }: {
    token: string;
    commitSha: string;
    path: string;
    message: string;
    input: {
      operationId: string;
      artifactHash: string;
      bytes: string;
    };
  }) {
    const commit = await request(
      token,
      `/commits/${encodeURIComponent(commitSha)}`,
    );
    if (
      !Array.isArray(commit.parents) ||
      commit.parents.length !== 1 ||
      typeof commit.parents[0]?.sha !== "string" ||
      !Array.isArray(commit.files) ||
      commit.files.length !== 1
    ) {
      return false;
    }
    const parentSha = commit.parents[0].sha;
    const expectedMessage = await signPublicationMessage(
      configuration.publicationSigningSecret,
      {
        expectedHead: parentSha,
        serializationVersion: "foundry.site-publication-artifacts.v2",
        path,
        artifactHash: input.artifactHash,
        contentHash: input.artifactHash,
        message,
      },
    );
    const file = commit.files[0];
    if (
      normalizeCommitMessage(commit.commit?.message) !==
        normalizeCommitMessage(expectedMessage) ||
      file?.filename !== path ||
      (file.status !== "added" && file.status !== "modified") ||
      typeof file.sha !== "string" ||
      file.sha !== (await gitBlobSha(input.bytes, commitSha))
    ) {
      return false;
    }
    const bytes = await requestRaw(
      token,
      `/contents/${path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}?ref=${encodeURIComponent(commitSha)}`,
    );
    return bytes !== null && new TextDecoder().decode(bytes) === input.bytes;
  }

  async function reconcileCampaignSendArtifact(input: {
    operationId: string;
    artifactHash: string;
    bytes: string;
  }) {
    try {
      if ((await sha256(input.bytes)) !== input.artifactHash) {
        return {
          outcome: "failed" as const,
          code: "git_artifact_hash_invalid",
        };
      }
      const token = await installationToken();
      const path = campaignSendArtifactPath(input.operationId);
      const operationTrailer = `Foundry-Bulk-Operation: ${input.operationId}`;
      const artifactTrailer = `Foundry-Bulk-Artifact: ${input.artifactHash}`;
      const message = [
        `Record campaign send artifact ${input.operationId}`,
        "",
        operationTrailer,
        artifactTrailer,
      ].join("\n");
      for (let page = 1; ; page += 1) {
        const commits = await request(
          token,
          `/commits?sha=${encodeURIComponent(
            configuration.productionBranch,
          )}&path=${encodeURIComponent(path)}&per_page=100&page=${page}`,
        );
        if (!Array.isArray(commits)) {
          return {
            outcome: "ambiguous" as const,
            code: "git_result_unknown",
          };
        }
        for (const commit of commits) {
          if (
            typeof commit?.sha === "string" &&
            typeof commit?.commit?.message === "string" &&
            commit.commit.message.split("\n").includes(operationTrailer) &&
            commit.commit.message.split("\n").includes(artifactTrailer) &&
            (await campaignSendCommitMatches({
              token,
              commitSha: commit.sha,
              path,
              message,
              input,
            }))
          ) {
            return {
              outcome: "committed" as const,
              commitSha: commit.sha,
            };
          }
        }
        if (commits.length < 100) return { outcome: "not_found" as const };
      }
    } catch {
      return {
        outcome: "ambiguous" as const,
        code: "git_result_unknown",
      };
    }
  }

  return {
    async getChannelConfigurationHash(serializationVersion) {
      const root =
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
          configuration.cloudflareAccountId,
        )}/builds`;
      const requestOptions = () => ({
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${configuration.cloudflareApiToken}`,
        },
      });
      const readEnvironment = async () => {
        const combined: Record<string, unknown> = {};
        let expectedTotalPages: number | undefined;
        for (let page = 1; ; page += 1) {
          const url = new URL(
            `${root}/triggers/${encodeURIComponent(
              configuration.cloudflareBuildTriggerId,
            )}/environment_variables`,
          );
          url.searchParams.set("page", String(page));
          url.searchParams.set("per_page", "100");
          const body = await fetchImplementation(
            url,
            requestOptions(),
          ).then(readJson);
          const result = body.result;
          const info = body.result_info;
          if (
            typeof result !== "object" ||
            result === null ||
            Array.isArray(result) ||
            typeof info !== "object" ||
            info === null ||
            !Number.isSafeInteger(info.page) ||
            info.page !== page ||
            !Number.isSafeInteger(info.total_pages) ||
            info.total_pages < page ||
            info.total_pages > 1_000 ||
            (expectedTotalPages !== undefined &&
              info.total_pages !== expectedTotalPages)
          ) {
            throw new Error("cloudflare_build_environment_invalid");
          }
          expectedTotalPages = info.total_pages;
          for (const [key, value] of Object.entries(result)) {
            if (Object.hasOwn(combined, key)) {
              throw new Error("cloudflare_build_environment_invalid");
            }
            combined[key] = value;
          }
          if (page === expectedTotalPages) {
            return combined;
          }
        }
      };
      const [triggersBody, environment] = await Promise.all([
        fetchImplementation(
          `${root}/workers/${encodeURIComponent(
            configuration.cloudflareScriptTag,
          )}/triggers`,
          requestOptions(),
        ).then(readJson),
        readEnvironment(),
      ]);
      const trigger = Array.isArray(triggersBody.result)
        ? triggersBody.result.find(
            (candidate: any) =>
              candidate?.trigger_uuid ===
              configuration.cloudflareBuildTriggerId,
          )
        : undefined;
      const repository = trigger?.repo_connection;
      const legacySerialization =
        serializationVersion ===
        "foundry.site-definition.canonical-json.v1";
      if (
        typeof trigger !== "object" ||
        trigger === null ||
        trigger.external_script_id !== configuration.cloudflareScriptTag ||
        trigger.deploy_command !== "npm run deploy" ||
        repository?.provider_type !== "github" ||
        typeof repository.provider_account_name !== "string" ||
        repository.provider_account_name.toLowerCase() !==
          configuration.owner.toLowerCase() ||
        typeof repository.repo_name !== "string" ||
        repository.repo_name.toLowerCase() !==
          configuration.repository.toLowerCase() ||
        !cloudflareWatchFilterAllows(
          configuration.productionBranch,
          trigger.branch_includes,
          trigger.branch_excludes,
        ) ||
        !cloudflareWatchFilterAllows(
          "packages/site-definition/src/published-site.json",
          trigger.path_includes,
          trigger.path_excludes,
        ) ||
        (!legacySerialization &&
          (!cloudflareWatchFilterAllows(
            "content/rich-text/foundry-probe.md",
            trigger.path_includes,
            trigger.path_excludes,
          ) ||
            !cloudflareWatchFilterAllows(
              "content/rich-text/nested/foundry-probe.md",
              trigger.path_includes,
              trigger.path_excludes,
            )))
      ) {
        throw new Error("cloudflare_build_configuration_invalid");
      }
      const pathIncludes = sortedStrings(trigger.path_includes);
      const fingerprintPathIncludes = legacySerialization
        ? pathIncludes.filter(
            (path) => path !== "content/rich-text/*",
          )
        : pathIncludes;
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
          cloudflareScriptName: configuration.cloudflareScriptName,
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
            pathIncludes: fingerprintPathIncludes,
            pathExcludes: sortedStrings(trigger.path_excludes),
            buildCachingEnabled: trigger.build_caching_enabled,
            environment: buildEnvironmentProjection(environment),
          },
        }),
      );
    },
    getProductionHead() {
      return productionHead();
    },
    reconcile(input) {
      return reconcileCampaignSendArtifact(input);
    },
    async publish(input) {
      const reconciled = await reconcileCampaignSendArtifact(input);
      if (reconciled.outcome !== "not_found") return reconciled;
      if ((await sha256(input.bytes)) !== input.artifactHash) {
        return {
          outcome: "failed" as const,
          code: "git_artifact_hash_invalid",
        };
      }
      let gitSideEffectStarted = false;
      try {
        const token = await installationToken();
        const expectedHead = await productionHead(token);
        const path = campaignSendArtifactPath(input.operationId);
        const message = [
          `Record campaign send artifact ${input.operationId}`,
          "",
          `Foundry-Bulk-Operation: ${input.operationId}`,
          `Foundry-Bulk-Artifact: ${input.artifactHash}`,
        ].join("\n");
        const signedMessage = await signPublicationMessage(
          configuration.publicationSigningSecret,
          {
            expectedHead,
            serializationVersion: "foundry.site-publication-artifacts.v2",
            path,
            artifactHash: input.artifactHash,
            contentHash: input.artifactHash,
            message,
          },
        );
        const separator = signedMessage.indexOf("\n\n");
        gitSideEffectStarted = true;
        const result = await graphqlRequest(
          token,
          `mutation CreateFoundryBulkSendArtifact(
            $input: CreateCommitOnBranchInput!
          ) {
            createCommitOnBranch(input: $input) {
              commit { oid }
            }
          }`,
          {
            input: {
              branch: {
                repositoryNameWithOwner: `${configuration.owner}/${configuration.repository}`,
                branchName: configuration.productionBranch,
              },
              expectedHeadOid: expectedHead,
              message: {
                headline:
                  separator === -1
                    ? signedMessage
                    : signedMessage.slice(0, separator),
                ...(separator === -1
                  ? {}
                  : { body: signedMessage.slice(separator + 2) }),
              },
              fileChanges: {
                additions: [
                  {
                    path,
                    contents: encodeBase64Utf8(input.bytes),
                  },
                ],
              },
            },
          },
        );
        const commitSha = result.data?.createCommitOnBranch?.commit?.oid;
        return typeof commitSha === "string"
          ? { outcome: "committed" as const, commitSha }
          : {
              outcome: "ambiguous" as const,
              code: "git_result_unknown",
            };
      } catch (error) {
        if (isDefiniteHttpRejection(error) && !isExpectedHeadMismatch(error)) {
          return {
            outcome: "failed" as const,
            code: "git_operation_failed",
          };
        }
        // An expected-head mismatch is a definite rejection: the branch moved
        // and no commit was created, whether or not the request was sent.
        return {
          outcome: "ambiguous" as const,
          code:
            gitSideEffectStarted && !isExpectedHeadMismatch(error)
              ? "git_result_unknown"
              : "git_head_moved",
        };
      }
    },
    async readPublishedArtifact(input: {
      commitSha: string;
      path: string;
    }) {
      let bytes: Uint8Array | null;
      try {
        const token = await installationToken();
        bytes = await requestRaw(
          token,
          `/contents/${input.path
            .split("/")
            .map(encodeURIComponent)
            .join("/")}?ref=${encodeURIComponent(input.commitSha)}`,
        );
      } catch (error) {
        if (isDefiniteHttpRejection(error)) {
          return null;
        }
        throw error;
      }
      if (bytes === null) {
        return null;
      }
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return null;
      }
    },
    async isReleaseLive(expected) {
      return (
        (await readReleaseMarker(expected)) &&
        (await readReleaseMarker(expected))
      );
    },
    async createCommit(input): Promise<PublicationCommitResult> {
      let gitSideEffectStarted = false;
      try {
        const artifacts = [...input.artifacts].sort(
          ({ path: left }, { path: right }) => left.localeCompare(right),
        );
        const legacyArtifact =
          input.serializationVersion ===
            "foundry.site-definition.canonical-json.v1" &&
          artifacts.length === 1 &&
          artifacts[0]?.path ===
            "packages/site-definition/src/published-site.json"
            ? artifacts[0]
            : null;
        const artifactsValid =
          legacyArtifact !== null
            ? (await sha256(legacyArtifact.bytes)) ===
              input.artifactHash
            : input.serializationVersion ===
                "foundry.site-publication-artifacts.v2" &&
              (await hashContentPublicationArtifacts(artifacts)) ===
                input.artifactHash;
        if (!artifactsValid) {
          return { state: "failed", detail: "git_operation_failed" };
        }
        if (!(await input.assertLease())) {
          return { state: "blocked", detail: "publication_lease_lost" };
        }
        const token = await installationToken();
        if ((await productionHead(token)) !== input.expectedHead) {
          return { state: "blocked", detail: "production_head_moved" };
        }
        let staleManagedPaths: string[] = [];
        if (legacyArtifact === null) {
          const baseCommit = await request(
            token,
            `/git/commits/${input.expectedHead}`,
          );
          if (typeof baseCommit.tree?.sha !== "string") {
            throw new Error("github_base_tree_invalid");
          }
          const baseBlobs = gitTreeBlobs(
            await request(
              token,
              `/git/trees/${baseCommit.tree.sha}?recursive=1`,
            ),
          );
          const artifactPaths = new Set(
            artifacts.map(({ path }) => path),
          );
          staleManagedPaths = [...baseBlobs.keys()]
            .filter(
              (path) =>
                managedRichTextArtifactPathPattern.test(path) &&
                !artifactPaths.has(
                  path as ContentPublicationArtifact["path"],
                ),
            )
            .sort();
        }
        const signedMessage = await signPublicationMessage(
          configuration.publicationSigningSecret,
          {
            expectedHead: input.expectedHead,
            serializationVersion: input.serializationVersion,
            path: artifacts[0]!.path,
            artifactHash: input.artifactHash,
            contentHash: input.contentHash,
            message: input.message,
          },
        );
        const separator = signedMessage.indexOf("\n\n");
        const headline =
          separator === -1
            ? signedMessage
            : signedMessage.slice(0, separator);
        const body =
          separator === -1
            ? null
            : signedMessage.slice(separator + 2);
        if (!(await input.assertLease())) {
          return { state: "blocked", detail: "publication_lease_lost" };
        }
        gitSideEffectStarted = true;
        const result = await graphqlRequest(
          token,
          `mutation CreateFoundryPublication(
            $input: CreateCommitOnBranchInput!
          ) {
            createCommitOnBranch(input: $input) {
              commit { oid }
            }
          }`,
          {
            input: {
              branch: {
                repositoryNameWithOwner:
                  `${configuration.owner}/${configuration.repository}`,
                branchName: configuration.productionBranch,
              },
              expectedHeadOid: input.expectedHead,
              message: {
                headline,
                ...(body === null ? {} : { body }),
              },
              fileChanges: {
                additions: artifacts.map(({ path, bytes }) => ({
                  path,
                  contents: encodeBase64Utf8(bytes),
                })),
                ...(staleManagedPaths.length === 0
                  ? {}
                  : {
                      deletions: staleManagedPaths.map((path) => ({
                        path,
                      })),
                    }),
              },
            },
          },
        );
        const commitSha = result.data?.createCommitOnBranch?.commit?.oid;
        if (typeof commitSha !== "string") {
          throw new Error("github_commit_invalid");
        }
        return { state: "committed", commitSha };
      } catch (error) {
        if (
          isDefiniteHttpRejection(error) &&
          isExpectedHeadMismatch(error)
        ) {
          return { state: "blocked", detail: "production_head_moved" };
        }
        if (isDefiniteHttpRejection(error)) {
          return { state: "failed", detail: "git_operation_failed" };
        }
        if (!gitSideEffectStarted) {
          return { state: "failed", detail: "git_operation_failed" };
        }
        return {
          state: "unknown",
          detail: "git_result_unknown",
        };
      }
    },
    async reconcileCommit(input) {
      try {
        const token = await installationToken();
        const signedMessage = await signPublicationMessage(
          configuration.publicationSigningSecret,
          {
            expectedHead: input.expectedHead,
            serializationVersion: input.serializationVersion,
            path: input.artifacts[0]!.path,
            artifactHash: input.artifactHash,
            contentHash: input.contentHash,
            message: input.message,
          },
        );
        if (input.candidateCommitSha !== undefined) {
          if (
            !(await commitMatchesExactPublication(
              token,
              input.candidateCommitSha,
              input,
              signedMessage,
            ))
          ) {
            return { state: "not-found" };
          }
          const head = await productionHead(token);
          if (head === input.candidateCommitSha) {
            return {
              state: "committed",
              commitSha: input.candidateCommitSha,
            };
          }
          const comparison = await request(
            token,
            `/compare/${input.candidateCommitSha}...${head}`,
          );
          return comparison.merge_base_commit?.sha ===
            input.candidateCommitSha &&
            (comparison.status === "ahead" ||
              comparison.status === "identical")
            ? {
                state: "committed",
                commitSha: input.candidateCommitSha,
              }
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
        const matches = commits.filter(
          (commit) =>
            typeof commit?.sha === "string" &&
            trailerMatches(commit?.commit?.message, input.publishId),
        );
        for (const match of matches) {
          if (
            await commitMatchesExactPublication(
              token,
              match.sha,
              input,
              signedMessage,
            )
          ) {
            return { state: "committed", commitSha: match.sha };
          }
        }
        return { state: "not-found" };
      } catch {
        return { state: "unknown" };
      }
    },
    async retryReference(input) {
      let refUpdateStarted = false;
      try {
        const artifacts = [...input.artifacts].sort(
          ({ path: left }, { path: right }) => left.localeCompare(right),
        );
        const legacyArtifact =
          input.serializationVersion ===
            "foundry.site-definition.canonical-json.v1" &&
          artifacts.length === 1 &&
          artifacts[0]?.path ===
            "packages/site-definition/src/published-site.json"
            ? artifacts[0]
            : null;
        const artifactsValid =
          legacyArtifact !== null
            ? (await sha256(legacyArtifact.bytes)) ===
              input.artifactHash
            : input.serializationVersion ===
                "foundry.site-publication-artifacts.v2" &&
              (await hashContentPublicationArtifacts(artifacts)) ===
                input.artifactHash;
        if (!artifactsValid) {
          return {
            state: "failed",
            detail: "git_reference_candidate_invalid",
          };
        }
        if (!(await input.assertLease())) {
          return { state: "blocked", detail: "publication_lease_lost" };
        }
        const token = await installationToken();
        const currentHead = await productionHead(token);
        if (
          currentHead !== input.expectedHead &&
          currentHead !== input.candidateCommitSha
        ) {
          return { state: "blocked", detail: "production_head_moved" };
        }
        const [candidate, comparison, expectedBlobShas] = await Promise.all([
          request(token, `/git/commits/${input.candidateCommitSha}`),
          request(
            token,
            `/compare/${input.expectedHead}...${input.candidateCommitSha}`,
          ),
          Promise.all(
            artifacts.map(({ bytes }) =>
              gitBlobSha(bytes, input.expectedHead),
            ),
          ),
        ]);
        const parents = Array.isArray(candidate.parents)
          ? candidate.parents
          : [];
        const files = Array.isArray(comparison.files) ? comparison.files : [];
        if (
          !trailerMatches(candidate.message, input.publishId) ||
          parents.length !== 1 ||
          parents[0]?.sha !== input.expectedHead ||
          comparison.status !== "ahead" ||
          comparison.ahead_by !== 1 ||
          comparison.total_commits !== 1 ||
          files.length >= 300
        ) {
          return {
            state: "failed",
            detail: "git_reference_candidate_invalid",
          };
        }
        const candidateMatches =
          legacyArtifact !== null
            ? files.length === 1 &&
              files[0]?.filename === legacyArtifact.path &&
              files[0]?.status === "modified" &&
              files[0]?.sha === expectedBlobShas[0]
            : typeof candidate.tree?.sha === "string" &&
              publicationCandidateMatches({
                artifacts,
                candidateBlobs: gitTreeBlobs(
                  await request(
                    token,
                    `/git/trees/${candidate.tree.sha}?recursive=1`,
                  ),
                ),
                expectedBlobShas,
                files,
              });
        if (!candidateMatches) {
          return {
            state: "failed",
            detail: "git_reference_candidate_invalid",
          };
        }
        if (currentHead === input.candidateCommitSha) {
          return {
            state: "committed",
            commitSha: input.candidateCommitSha,
          };
        }
        if (!(await input.assertLease())) {
          return { state: "blocked", detail: "publication_lease_lost" };
        }
        refUpdateStarted = true;
        try {
          await request(
            token,
            `/git/refs/heads/${configuration.productionBranch
              .split("/")
              .map(encodeURIComponent)
              .join("/")}`,
            {
              method: "PATCH",
              body: JSON.stringify({
                sha: input.candidateCommitSha,
                force: false,
              }),
            },
          );
        } catch (error) {
          if (isNonFastForwardRefError(error)) {
            return { state: "blocked", detail: "production_head_moved" };
          }
          if (isDefiniteHttpRejection(error)) {
            return {
              state: "failed",
              detail: "git_reference_update_failed",
            };
          }
          throw error;
        }
        return {
          state: "committed",
          commitSha: input.candidateCommitSha,
        };
      } catch {
        return refUpdateStarted
          ? {
              state: "unknown",
              detail: `git_reference_result_unknown:${input.candidateCommitSha}`,
            }
          : {
              state: "failed",
              detail: "git_reference_candidate_unverified",
            };
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
            build?.build_trigger_metadata?.commit_hash !== commitSha
          ) {
            return "unknown";
          }
          if (
            build?.status === "queued" ||
            build?.status === "initializing" ||
            build?.status === "running"
          ) {
            return "building";
          }
          if (build?.status === "stopped") {
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
    async retryDeployment({ commitSha, assertDispatch }) {
      if (!(await assertDispatch())) {
        return {
          state: "blocked" as const,
          detail: "deployment_retry_claim_lost" as const,
        };
      }
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
        if (
          body.success === true &&
          typeof body.result?.build_uuid === "string" &&
          body.result.build_uuid.trim() !== ""
        ) {
          return {
            state: "requested" as const,
            deploymentId: body.result.build_uuid,
          };
        }
        return body.success === false
          ? { state: "failed" as const }
          : { state: "unknown" as const };
      } catch (error) {
        return isDefiniteHttpRejection(error)
          ? { state: "failed" as const }
          : { state: "unknown" as const };
      }
    },
  };
}
