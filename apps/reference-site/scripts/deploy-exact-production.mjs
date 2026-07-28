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

import { assertExactProductionHead } from "./assert-exact-production-head.mjs";

const cloudflareApiBaseUrl =
  "https://api.cloudflare.com/client/v4";
const objectIdPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const versionIdPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const activationPathPattern =
  /^\/client\/v4\/accounts\/[^/]+\/workers\/scripts\/[^/]+\/deployments$/u;
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
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
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
  let fenceError;
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(
        request.url ?? "/",
        "http://127.0.0.1",
      );
      const isActivation =
        request.method === "POST" &&
        activationPathPattern.test(requestUrl.pathname);
      if (isActivation) {
        try {
          assertHead();
          activationCount += 1;
        } catch (error) {
          fenceError = error;
          response.writeHead(409, {
            "content-type": "application/json",
          });
          response.end(
            JSON.stringify({
              success: false,
              errors: [{ code: 10000, message: "Production head moved." }],
            }),
          );
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
      const body = await readRequestBody(request);
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
      response.statusCode = upstream.status;
      copyResponseHeaders(upstream, response);
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
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
    if (fenceError !== undefined) {
      throw fenceError;
    }
    if (activationCount !== 1) {
      throw new Error(
        `exact_version_activation_count_invalid:${activationCount}`,
      );
    }
    assertHead();
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
  uploadVersion = uploadExactVersion,
  activateVersion = activateExactVersion,
} = {}) {
  assertHead();
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
