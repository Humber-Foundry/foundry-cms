#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { assertExactProductionContent } from "./assert-exact-production-content.mjs";
import { assertExactProductionHead } from "./assert-exact-production-head.mjs";

const cloudflareApiBaseUrl =
  "https://api.cloudflare.com/client/v4";
const objectIdPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const versionIdPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const activationPathPattern =
  /^\/client\/v4\/accounts\/[^/]+\/workers\/scripts\/[^/]+\/deployments$/u;
const maximumActivationBodyBytes = 64 * 1024;
const hopByHopHeaders = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function waitForProcess(process, failurePrefix) {
  return new Promise((resolve, reject) => {
    process.once("error", reject);
    process.once("exit", (code, signal) => {
      if (code !== 0) {
        reject(
          new Error(
            `${failurePrefix}:${code ?? "signal"}:${signal ?? "none"}`,
          ),
        );
        return;
      }
      resolve();
    });
  });
}

function readUploadedVersion(outputPath) {
  const entries = readFileSync(outputPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
  const uploads = entries.filter(
    (entry) => entry.type === "version-upload",
  );
  if (
    uploads.length !== 1 ||
    typeof uploads[0].version_id !== "string" ||
    !versionIdPattern.test(uploads[0].version_id)
  ) {
    throw new Error("exact_version_upload_output_invalid");
  }
  return uploads[0].version_id;
}

export async function uploadExactVersion({
  environment = process.env,
  startUpload,
} = {}) {
  const outputDirectory = mkdtempSync(
    join(tmpdir(), "foundry-exact-upload-"),
  );
  const outputPath = join(outputDirectory, "wrangler-output.jsonl");
  const expectedCommit =
    environment.WORKERS_CI_COMMIT_SHA?.trim().toLowerCase();
  if (
    expectedCommit === undefined ||
    !objectIdPattern.test(expectedCommit)
  ) {
    throw new Error("exact_version_upload_configuration_invalid");
  }
  try {
    const upload =
      startUpload?.({ outputPath, expectedCommit }) ??
      spawn(
        "opennextjs-cloudflare",
        [
          "upload",
          "--",
          "--tag",
          expectedCommit,
          "--message",
          `Foundry exact production revision ${expectedCommit}`,
        ],
        {
          stdio: "inherit",
          shell: false,
          env: {
            ...environment,
            WRANGLER_OUTPUT_FILE_PATH: outputPath,
          },
        },
      );
    await waitForProcess(upload, "exact_version_upload_failed");
    return readUploadedVersion(outputPath);
  } finally {
    rmSync(outputDirectory, { force: true, recursive: true });
  }
}

function copyResponseHeaders(upstream, response) {
  for (const [name, value] of upstream.headers) {
    if (
      name.toLowerCase() !== "content-encoding" &&
      !hopByHopHeaders.has(name.toLowerCase())
    ) {
      response.setHeader(name, value);
    }
  }
}

async function readRequestBody(request) {
  const chunks = [];
  let bytesRead = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytesRead += bytes.byteLength;
    if (bytesRead > maximumActivationBodyBytes) {
      throw new Error("exact_activation_body_too_large");
    }
    chunks.push(bytes);
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}

function activationPayloadIsExact(body, versionId) {
  if (body === undefined) {
    return false;
  }
  try {
    const payload = JSON.parse(body.toString("utf8"));
    return (
      typeof payload === "object" &&
      payload !== null &&
      payload.strategy === "percentage" &&
      Array.isArray(payload.versions) &&
      payload.versions.length === 1 &&
      typeof payload.versions[0] === "object" &&
      payload.versions[0] !== null &&
      payload.versions[0].version_id === versionId &&
      payload.versions[0].percentage === 100
    );
  } catch {
    return false;
  }
}

function rejectActivation(response, message) {
  response.writeHead(409, {
    "content-type": "application/json",
  });
  response.end(
    JSON.stringify({
      success: false,
      errors: [{ code: 10000, message }],
    }),
  );
}

function parseCloudflareResult(body) {
  try {
    const payload = JSON.parse(body.toString("utf8"));
    if (
      typeof payload !== "object" ||
      payload === null ||
      payload.success !== true ||
      typeof payload.result !== "object" ||
      payload.result === null
    ) {
      throw new Error("invalid_result");
    }
    return payload.result;
  } catch {
    throw new Error("exact_activation_cloudflare_response_invalid");
  }
}

function deploymentTraffic(result) {
  if (
    !Array.isArray(result.deployments) ||
    result.deployments.length === 0
  ) {
    throw new Error("exact_activation_baseline_unavailable");
  }
  const latest = result.deployments[0];
  if (
    typeof latest !== "object" ||
    latest === null ||
    typeof latest.id !== "string" ||
    latest.id.length === 0 ||
    !Array.isArray(latest.versions) ||
    latest.versions.length === 0
  ) {
    throw new Error("exact_activation_baseline_invalid");
  }
  const versions = latest.versions.map((version) => {
    if (
      typeof version !== "object" ||
      version === null ||
      typeof version.version_id !== "string" ||
      !versionIdPattern.test(version.version_id) ||
      typeof version.percentage !== "number" ||
      !Number.isFinite(version.percentage) ||
      version.percentage <= 0 ||
      version.percentage > 100
    ) {
      throw new Error("exact_activation_baseline_invalid");
    }
    return {
      version_id: version.version_id,
      percentage: version.percentage,
    };
  });
  const total = versions.reduce(
    (sum, version) => sum + version.percentage,
    0,
  );
  if (Math.abs(total - 100) > Number.EPSILON * 100) {
    throw new Error("exact_activation_baseline_invalid");
  }
  return { deploymentId: latest.id, versions };
}

function deploymentId(result) {
  if (typeof result.id !== "string" || result.id.length === 0) {
    throw new Error("exact_activation_cloudflare_response_invalid");
  }
  return result.id;
}

async function restorePreviousDeployment({
  activatedDeploymentId,
  activationPath,
  headers,
  previousVersions,
  upstreamBaseUrl,
}) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const latestResponse = await fetch(
        new URL(activationPath, upstreamBaseUrl),
        {
          method: "GET",
          headers,
          redirect: "manual",
        },
      );
      const latestBody = Buffer.from(await latestResponse.arrayBuffer());
      if (!latestResponse.ok) {
        throw new Error("exact_activation_rollback_lookup_failed");
      }
      const latest = deploymentTraffic(parseCloudflareResult(latestBody));
      if (latest.deploymentId !== activatedDeploymentId) {
        return;
      }

      const rollbackResponse = await fetch(
        new URL(activationPath, upstreamBaseUrl),
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            strategy: "percentage",
            versions: previousVersions,
            annotations: {
              "workers/message":
                "Foundry automatic rollback after protected ref movement",
            },
          }),
          redirect: "manual",
        },
      );
      const rollbackBody = Buffer.from(
        await rollbackResponse.arrayBuffer(),
      );
      if (!rollbackResponse.ok) {
        throw new Error("exact_activation_rollback_request_failed");
      }
      deploymentId(parseCloudflareResult(rollbackBody));
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error("exact_activation_rollback_failed", {
    cause: lastError,
  });
}

export async function activateExactVersion({
  versionId,
  assertHead = assertExactProductionHead,
  environment = process.env,
  startActivation,
  upstreamBaseUrl =
    environment.CLOUDFLARE_API_BASE_URL ?? cloudflareApiBaseUrl,
} = {}) {
  if (typeof versionId !== "string" || !versionIdPattern.test(versionId)) {
    throw new Error("exact_version_id_invalid");
  }

  let activationCount = 0;
  let activationAttempted = false;
  let activationError;
  let activationRecord;
  let baseline;
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(
        request.url ?? "/",
        "http://127.0.0.1",
      );
      const isActivation =
        request.method === "POST" &&
        activationPathPattern.test(requestUrl.pathname);
      const isDeploymentLookup =
        request.method === "GET" &&
        activationPathPattern.test(requestUrl.pathname);
      const body = await readRequestBody(request);
      if (isActivation) {
        if (activationAttempted) {
          activationError = new Error("exact_activation_repeated");
          rejectActivation(response, "Activation already attempted.");
          return;
        }
        activationAttempted = true;
        if (!activationPayloadIsExact(body, versionId)) {
          activationError = new Error("exact_activation_payload_invalid");
          rejectActivation(response, "Exact activation payload required.");
          return;
        }
        if (baseline === undefined) {
          activationError = new Error(
            "exact_activation_baseline_unavailable",
          );
          rejectActivation(
            response,
            "Previous production deployment required.",
          );
          return;
        }
        try {
          assertHead();
        } catch (error) {
          activationError = error;
          rejectActivation(response, "Production head moved.");
          return;
        }
      }

      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (
          value !== undefined &&
          name.toLowerCase() !== "host" &&
          !hopByHopHeaders.has(name.toLowerCase())
        ) {
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
      }
      const upstream = await fetch(
        new URL(
          `${requestUrl.pathname}${requestUrl.search}`,
          upstreamBaseUrl,
        ),
        {
          method: request.method,
          headers,
          body,
          redirect: "manual",
        },
      );
      const upstreamBody = Buffer.from(await upstream.arrayBuffer());
      if (isDeploymentLookup && upstream.ok) {
        baseline = deploymentTraffic(
          parseCloudflareResult(upstreamBody),
        );
      }
      if (isActivation && upstream.ok) {
        const activatedDeploymentId = deploymentId(
          parseCloudflareResult(upstreamBody),
        );
        activationCount += 1;
        activationRecord = {
          activatedDeploymentId,
          activationPath: requestUrl.pathname,
          headers: new Headers(headers),
          previousVersions: baseline.versions,
        };
      }
      response.statusCode = upstream.status;
      copyResponseHeaders(upstream, response);
      response.end(upstreamBody);
    } catch (error) {
      activationError ??= error;
      response.writeHead(502, {
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify({
          success: false,
          errors: [{ code: 10001, message: "Activation proxy failed." }],
        }),
      );
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("exact_activation_proxy_unavailable");
    }
    const localApiBaseUrl =
      `http://127.0.0.1:${address.port}/client/v4`;
    const activation =
      startActivation?.({ localApiBaseUrl, versionId }) ??
      spawn(
        "wrangler",
        [
          "versions",
          "deploy",
          "--version-id",
          versionId,
          "--percentage",
          "100",
          "--message",
          `Foundry exact production revision ${
            environment.WORKERS_CI_COMMIT_SHA
          }`,
          "--yes",
        ],
        {
          stdio: "inherit",
          shell: false,
          env: {
            ...environment,
            CLOUDFLARE_API_BASE_URL: localApiBaseUrl,
          },
        },
      );
    await waitForProcess(activation, "exact_version_activation_failed");
    if (activationError !== undefined) {
      throw activationError;
    }
    if (activationCount !== 1) {
      throw new Error(
        `exact_version_activation_count_invalid:${activationCount}`,
      );
    }
    try {
      assertHead();
    } catch (headError) {
      if (activationRecord === undefined) {
        throw headError;
      }
      try {
        await restorePreviousDeployment({
          ...activationRecord,
          upstreamBaseUrl,
        });
      } catch (rollbackError) {
        throw new AggregateError(
          [headError, rollbackError],
          "exact_activation_rollback_failed",
        );
      }
      throw headError;
    }
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

export async function deployExactProduction({
  assertHead = assertExactProductionHead,
  authorizeContent = assertExactProductionContent,
  uploadVersion = uploadExactVersion,
  activateVersion = activateExactVersion,
} = {}) {
  assertHead();
  await authorizeContent();
  const versionId = await uploadVersion();
  assertHead();
  await activateVersion({ versionId, assertHead });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  deployExactProduction()
    .then(() => {
      console.log("Exact production deployment completed.");
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
