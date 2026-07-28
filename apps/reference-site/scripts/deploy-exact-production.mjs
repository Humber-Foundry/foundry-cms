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
import {
  assertExactProductionHead,
  assertExactProductionSource,
} from "./assert-exact-production-head.mjs";

const cloudflareApiBaseUrl =
  "https://api.cloudflare.com/client/v4";
const objectIdPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const versionIdPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const activationPathPattern =
  /^\/client\/v4\/accounts\/[^/]+\/workers\/scripts\/[^/]+\/deployments$/u;
const maximumActivationBodyBytes = 64 * 1024;
const cloudflareRequestTimeoutMs = 30_000;
const deploymentHistoryReconciliationMs = 30_000;
const deploymentHistoryPollMs = 250;
const loopbackRequestArrivalMs = 250;
const loopbackRequestBodyTimeoutMs = 5_000;
const loopbackShutdownTimeoutMs = 5_000;
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

async function readRequestBody(
  request,
  timeoutMs = loopbackRequestBodyTimeoutMs,
) {
  const chunks = [];
  let bytesRead = 0;
  let timeout;
  const body = (async () => {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytesRead += bytes.byteLength;
      if (bytesRead > maximumActivationBodyBytes) {
        throw new Error("exact_activation_body_too_large");
      }
      chunks.push(bytes);
    }
    return chunks.length === 0 ? undefined : Buffer.concat(chunks);
  })();
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      const error = new Error("exact_activation_body_timeout");
      request.destroy(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([body, deadline]);
  } finally {
    clearTimeout(timeout);
  }
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

function deploymentList(result) {
  if (!Array.isArray(result.deployments)) {
    throw new Error("exact_activation_baseline_invalid");
  }
  return result.deployments.map((deployment) => {
    if (
      typeof deployment !== "object" ||
      deployment === null ||
      typeof deployment.id !== "string" ||
      deployment.id.length === 0 ||
      !Array.isArray(deployment.versions) ||
      deployment.versions.length === 0
    ) {
      throw new Error("exact_activation_baseline_invalid");
    }
    const versions = deployment.versions.map((version) => {
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
    return { deploymentId: deployment.id, versions };
  });
}

function deploymentId(result) {
  if (typeof result.id !== "string" || result.id.length === 0) {
    throw new Error("exact_activation_cloudflare_response_invalid");
  }
  return result.id;
}

async function readDeploymentList({
  abortSignal,
  activationPath,
  headers,
  requestTimeoutMs = cloudflareRequestTimeoutMs,
  upstreamBaseUrl,
}) {
  const response = await fetch(
    new URL(activationPath, upstreamBaseUrl),
    {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.any(
        [
          AbortSignal.timeout(
            Math.max(
              1,
              Math.min(cloudflareRequestTimeoutMs, requestTimeoutMs),
            ),
          ),
          abortSignal,
        ].filter((signal) => signal !== undefined),
      ),
    },
  );
  const body = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error("exact_activation_deployment_lookup_failed");
  }
  return deploymentList(parseCloudflareResult(body));
}

function isExactVersionDeployment(deployment, versionId) {
  return (
    deployment?.versions.length === 1 &&
    deployment.versions[0]?.version_id === versionId &&
    deployment.versions[0].percentage === 100
  );
}

async function reconcileActivationAttempt({
  activationPath,
  baseline,
  headers,
  upstreamBaseUrl,
  versionId,
}) {
  const deadline = Date.now() + deploymentHistoryReconciliationMs;
  let lastError;
  while (Date.now() < deadline) {
    const requestBudget = deadline - Date.now();
    try {
      const deployments = await readDeploymentList({
        activationPath,
        headers,
        requestTimeoutMs: requestBudget,
        upstreamBaseUrl,
      });
      const baselineIndex = deployments.findIndex(
        ({ deploymentId: candidate }) =>
          candidate === baseline.deploymentId,
      );
      const activatedIndex = deployments.findIndex((deployment) =>
        isExactVersionDeployment(deployment, versionId),
      );
      if (activatedIndex >= 0 && baselineIndex > activatedIndex) {
        return {
          state: activatedIndex === 0 ? "active" : "superseded",
          deployment: deployments[activatedIndex],
        };
      }
    } catch (error) {
      lastError = error;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(deploymentHistoryPollMs, remaining),
        ),
      );
    }
  }
  throw new Error("exact_activation_reconciliation_failed", {
    cause: lastError,
  });
}

async function readOwnedDeploymentPosition({
  activatedDeploymentId,
  activationPath,
  headers,
  upstreamBaseUrl,
}) {
  const deadline = Date.now() + deploymentHistoryReconciliationMs;
  let lastError;
  while (Date.now() < deadline) {
    const requestBudget = deadline - Date.now();
    try {
      const deployments = await readDeploymentList({
        activationPath,
        headers,
        requestTimeoutMs: requestBudget,
        upstreamBaseUrl,
      });
      const ownedIndex = deployments.findIndex(
        ({ deploymentId: candidate }) =>
          candidate === activatedDeploymentId,
      );
      if (ownedIndex === 0) {
        return { state: "current", deployments };
      }
      if (ownedIndex > 0) {
        return { state: "superseded", deployments };
      }
    } catch (error) {
      lastError = error;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(deploymentHistoryPollMs, remaining),
        ),
      );
    }
  }
  throw new Error("exact_activation_history_unverified", {
    cause: lastError,
  });
}

function deploymentsAreEquivalent(left, right) {
  return (
    left.versions.length === right.versions.length &&
    left.versions.every(
      (version, index) =>
        version.version_id === right.versions[index]?.version_id &&
        version.percentage === right.versions[index]?.percentage,
    )
  );
}

function rollbackResponseMayHaveApplied(status) {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status === 499 ||
    status >= 500
  );
}

async function reconcileAmbiguousRollback({
  activationPath,
  headers,
  replacedDeploymentId,
  target,
  upstreamBaseUrl,
}) {
  const deadline = Date.now() + deploymentHistoryReconciliationMs;
  let lastError;
  while (Date.now() < deadline) {
    const requestBudget = deadline - Date.now();
    try {
      const deployments = await readDeploymentList({
        activationPath,
        headers,
        requestTimeoutMs: requestBudget,
        upstreamBaseUrl,
      });
      const replacedIndex = deployments.findIndex(
        ({ deploymentId: candidate }) =>
          candidate === replacedDeploymentId,
      );
      if (replacedIndex > 0) {
        const intervening = deployments.slice(0, replacedIndex);
        const restoredIndex = intervening.findIndex((deployment) =>
          deploymentsAreEquivalent(deployment, target),
        );
        if (restoredIndex >= 0) {
          return {
            state: restoredIndex === 0 ? "restored" : "superseded",
            deployment: intervening[restoredIndex],
            deployments,
            replacedIndex,
          };
        }
        // The protected activation is no longer current. A concurrent
        // deployment won the race, so retrying the stale rollback would
        // overwrite it even if the ambiguous request was rejected.
        return { state: "superseded" };
      }
    } catch (error) {
      lastError = error;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(deploymentHistoryPollMs, remaining),
        ),
      );
    }
  }
  throw new Error("exact_activation_rollback_ambiguous", {
    cause: lastError,
  });
}

function productionActivationPath(environment) {
  const accountId = environment.FOUNDRY_CLOUDFLARE_ACCOUNT_ID?.trim();
  const scriptName =
    environment.FOUNDRY_CLOUDFLARE_SCRIPT_NAME?.trim();
  if (
    accountId === undefined ||
    accountId.length === 0 ||
    scriptName === undefined ||
    scriptName.length === 0
  ) {
    throw new Error("exact_activation_target_invalid");
  }
  return (
    `/client/v4/accounts/${encodeURIComponent(accountId)}` +
    `/workers/scripts/${encodeURIComponent(scriptName)}/deployments`
  );
}

export async function assertProductionDeploymentAbsent({
  environment = process.env,
  upstreamBaseUrl = cloudflareApiBaseUrl,
} = {}) {
  const apiToken = environment.CLOUDFLARE_API_TOKEN?.trim();
  if (apiToken === undefined || apiToken.length === 0) {
    throw new Error("exact_activation_baseline_configuration_invalid");
  }
  const deployments = await readDeploymentList({
    activationPath: productionActivationPath(environment),
    headers: new Headers({ authorization: `Bearer ${apiToken}` }),
    upstreamBaseUrl,
  });
  if (deployments.length !== 0) {
    throw new Error("production_baseline_already_exists");
  }
}

export async function assertProductionDeploymentBaseline({
  environment = process.env,
  upstreamBaseUrl = cloudflareApiBaseUrl,
} = {}) {
  const apiToken = environment.CLOUDFLARE_API_TOKEN?.trim();
  if (apiToken === undefined || apiToken.length === 0) {
    throw new Error("exact_activation_baseline_configuration_invalid");
  }
  const deployments = await readDeploymentList({
    activationPath: productionActivationPath(environment),
    headers: new Headers({ authorization: `Bearer ${apiToken}` }),
    upstreamBaseUrl,
  });
  if (deployments.length === 0) {
    throw new Error("exact_activation_baseline_unavailable");
  }
}

async function restorePreviousDeployment({
  activatedDeploymentId,
  activationPath,
  headers,
  upstreamBaseUrl,
}) {
  const ownedDeployments = new Set([activatedDeploymentId]);
  let expectedOwnedDeployment = activatedDeploymentId;
  let target;
  let lastError;
  const reconcileUnknownRollback = async () => {
    const reconciled = await reconcileAmbiguousRollback({
      activationPath,
      headers,
      replacedDeploymentId: expectedOwnedDeployment,
      target,
      upstreamBaseUrl,
    });
    if (reconciled.state === "superseded") {
      return true;
    }
    const rollbackDeploymentId = reconciled.deployment.deploymentId;
    ownedDeployments.add(rollbackDeploymentId);
    expectedOwnedDeployment = rollbackDeploymentId;
    if (reconciled.replacedIndex === 1) {
      return true;
    }
    if (reconciled.replacedIndex < 2) {
      throw new Error("exact_activation_rollback_history_invalid");
    }
    target = reconciled.deployments
      .slice(1, reconciled.replacedIndex)
      .find(
        ({ deploymentId: candidate }) =>
          !ownedDeployments.has(candidate),
      );
    if (target === undefined) {
      throw new Error("exact_activation_rollback_history_invalid");
    }
    return false;
  };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const beforePosition = await readOwnedDeploymentPosition({
        activatedDeploymentId: expectedOwnedDeployment,
        activationPath,
        headers,
        upstreamBaseUrl,
      });
      if (beforePosition.state === "superseded") {
        return;
      }
      const before = beforePosition.deployments;
      target ??= before.find(
        ({ deploymentId: candidate }) =>
          !ownedDeployments.has(candidate),
      );
      if (target === undefined) {
        throw new Error("exact_activation_rollback_baseline_unavailable");
      }

      let rollbackResponse;
      let rollbackBody;
      try {
        rollbackResponse = await fetch(
          new URL(activationPath, upstreamBaseUrl),
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              strategy: "percentage",
              versions: target.versions,
              annotations: {
                "workers/message":
                  "Foundry automatic rollback after protected ref movement",
              },
            }),
            redirect: "manual",
            signal: AbortSignal.timeout(cloudflareRequestTimeoutMs),
          },
        );
        rollbackBody = Buffer.from(
          await rollbackResponse.arrayBuffer(),
        );
      } catch (error) {
        if (await reconcileUnknownRollback()) {
          return;
        }
        continue;
      }
      if (!rollbackResponse.ok) {
        if (rollbackResponseMayHaveApplied(rollbackResponse.status)) {
          if (await reconcileUnknownRollback()) {
            return;
          }
          continue;
        }
        // Redirects and definitive client rejections did not apply. They
        // still fail closed: operators must correct the request or
        // credentials rather than blindly retrying the rollback.
        throw new Error("exact_activation_rollback_request_rejected");
      }
      let rollbackDeploymentId;
      try {
        rollbackDeploymentId = deploymentId(
          parseCloudflareResult(rollbackBody),
        );
      } catch (error) {
        if (await reconcileUnknownRollback()) {
          return;
        }
        continue;
      }
      ownedDeployments.add(rollbackDeploymentId);
      const replacedDeploymentId = expectedOwnedDeployment;
      expectedOwnedDeployment = rollbackDeploymentId;
      const afterPosition = await readOwnedDeploymentPosition({
        activatedDeploymentId: rollbackDeploymentId,
        activationPath,
        headers,
        upstreamBaseUrl,
      });
      if (afterPosition.state === "superseded") {
        return;
      }
      const after = afterPosition.deployments;
      const replacedIndex = after.findIndex(
        ({ deploymentId: candidate }) =>
          candidate === replacedDeploymentId,
      );
      if (replacedIndex === 1) {
        return;
      }
      if (replacedIndex < 2) {
        throw new Error("exact_activation_rollback_history_invalid");
      }
      target = after
        .slice(1, replacedIndex)
        .find(
          ({ deploymentId: candidate }) =>
            !ownedDeployments.has(candidate),
        );
      if (target === undefined) {
        throw new Error("exact_activation_rollback_history_invalid");
      }
    } catch (error) {
      if (
        error?.message === "exact_activation_rollback_ambiguous" ||
        error?.message === "exact_activation_rollback_request_rejected"
      ) {
        throw error;
      }
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
  loopbackBodyTimeoutMs = loopbackRequestBodyTimeoutMs,
  loopbackDrainTimeoutMs = loopbackShutdownTimeoutMs,
  startActivation,
  upstreamBaseUrl = cloudflareApiBaseUrl,
} = {}) {
  if (typeof versionId !== "string" || !versionIdPattern.test(versionId)) {
    throw new Error("exact_version_id_invalid");
  }
  if (
    !Number.isSafeInteger(loopbackBodyTimeoutMs) ||
    loopbackBodyTimeoutMs <= 0 ||
    !Number.isSafeInteger(loopbackDrainTimeoutMs) ||
    loopbackDrainTimeoutMs <= 0
  ) {
    throw new Error("exact_activation_proxy_timeout_invalid");
  }
  const expectedActivationPath = productionActivationPath(environment);

  let activationCount = 0;
  let activationAttempted = false;
  let activationError;
  let activationRecord;
  let activationRequest;
  let activationBaseline;
  let requestHandlerError;
  const handlerAbortController = new AbortController();
  const inFlightRequests = new Set();
  const loopbackSockets = new Set();
  const server = createServer((request, response) => {
    const handler = (async () => {
      try {
        const requestUrl = new URL(
          request.url ?? "/",
          "http://127.0.0.1",
        );
        const isActivation =
          request.method === "POST" &&
          requestUrl.pathname === expectedActivationPath;
        const isOtherActivation =
          request.method === "POST" &&
          activationPathPattern.test(requestUrl.pathname) &&
          !isActivation;
        const body = await readRequestBody(
          request,
          loopbackBodyTimeoutMs,
        );
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (
            value !== undefined &&
            name.toLowerCase() !== "host" &&
            !hopByHopHeaders.has(name.toLowerCase())
          ) {
            headers.set(
              name,
              Array.isArray(value) ? value.join(", ") : value,
            );
          }
        }
        if (isOtherActivation) {
          activationError = new Error("exact_activation_target_invalid");
          rejectActivation(response, "Exact activation target required.");
          return;
        }
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
          try {
            assertHead();
            const deployments = await readDeploymentList({
              abortSignal: handlerAbortController.signal,
              activationPath: expectedActivationPath,
              headers,
              upstreamBaseUrl,
            });
            activationBaseline = deployments[0];
            if (activationBaseline === undefined) {
              activationError = new Error(
                "exact_activation_baseline_unavailable",
              );
              rejectActivation(
                response,
                "Provision a production baseline before exact deployment.",
              );
              return;
            }
            assertHead();
            activationRequest = {
              activationPath: requestUrl.pathname,
              headers: new Headers(headers),
            };
          } catch (error) {
            activationError = error;
            rejectActivation(response, "Production head moved.");
            return;
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
            signal: AbortSignal.any([
              AbortSignal.timeout(cloudflareRequestTimeoutMs),
              handlerAbortController.signal,
            ]),
          },
        );
        const upstreamBody = Buffer.from(await upstream.arrayBuffer());
        if (isActivation && upstream.ok) {
          const activatedDeploymentId = deploymentId(
            parseCloudflareResult(upstreamBody),
          );
          activationCount += 1;
          activationRecord = {
            activatedDeploymentId,
            activationPath: requestUrl.pathname,
            headers: new Headers(headers),
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
    })();
    inFlightRequests.add(handler);
    void handler.then(
      () => {
        inFlightRequests.delete(handler);
      },
      (error) => {
        requestHandlerError ??= error;
        inFlightRequests.delete(handler);
      },
    );
  });
  server.on("connection", (socket) => {
    loopbackSockets.add(socket);
    socket.once("close", () => {
      loopbackSockets.delete(socket);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  let serverShutdownPromise;
  const shutdownActivationServer = () => {
    serverShutdownPromise ??= (async () => {
      let forceCloseTimer;
      const closePromise = new Promise((resolve, reject) => {
        forceCloseTimer = setTimeout(() => {
          handlerAbortController.abort(
            new Error("exact_activation_proxy_shutdown_timeout"),
          );
          for (const socket of loopbackSockets) {
            socket.destroy();
          }
        }, loopbackDrainTimeoutMs);
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      try {
        await closePromise;
      } finally {
        clearTimeout(forceCloseTimer);
      }

      const handlers = Promise.all([...inFlightRequests]);
      let handlerDrainTimer;
      const handlerDrainDeadline = new Promise((_, reject) => {
        handlerDrainTimer = setTimeout(() => {
          handlerAbortController.abort(
            new Error("exact_activation_proxy_shutdown_timeout"),
          );
          for (const socket of loopbackSockets) {
            socket.destroy();
          }
          reject(
            new Error("exact_activation_proxy_shutdown_timeout"),
          );
        }, loopbackDrainTimeoutMs);
      });
      try {
        await Promise.race([handlers, handlerDrainDeadline]);
      } finally {
        clearTimeout(handlerDrainTimer);
      }
    })();
    return serverShutdownPromise;
  };
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
    let activationProcessError;
    try {
      await waitForProcess(activation, "exact_version_activation_failed");
    } catch (error) {
      activationProcessError = error;
    }
    const requestArrivalDeadline = Date.now() + loopbackRequestArrivalMs;
    while (
      !activationAttempted &&
      activationError === undefined &&
      Date.now() < requestArrivalDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await shutdownActivationServer();
    activationError ??= requestHandlerError;
    if (
      activationCount === 0 &&
      activationRequest !== undefined &&
      activationBaseline !== undefined
    ) {
      try {
        const reconciled = await reconcileActivationAttempt({
          ...activationRequest,
          baseline: activationBaseline,
          upstreamBaseUrl,
          versionId,
        });
        if (
          reconciled.state === "active" ||
          reconciled.state === "superseded"
        ) {
          activationCount = 1;
          activationRecord = {
            activatedDeploymentId:
              reconciled.deployment.deploymentId,
            ...activationRequest,
          };
          if (reconciled.state === "active") {
            activationError = undefined;
            activationProcessError = undefined;
          } else {
            activationError = new Error("exact_activation_superseded");
          }
        }
      } catch (error) {
        activationError = new AggregateError(
          [activationError, error].filter(
            (candidate) => candidate !== undefined,
          ),
          "exact_activation_reconciliation_failed",
        );
      }
    }
    if (activationCount === 1) {
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
      if (activationError === undefined) {
        activationProcessError = undefined;
      }
    }
    if (activationError !== undefined) {
      throw activationError;
    }
    if (activationProcessError !== undefined) {
      throw activationProcessError;
    }
    if (activationCount !== 1) {
      throw new Error(
        `exact_version_activation_count_invalid:${activationCount}`,
      );
    }
  } finally {
    await shutdownActivationServer();
  }
}

export async function deployExactProduction({
  assertHead = assertExactProductionHead,
  assertSource = assertExactProductionSource,
  authorizeContent = assertExactProductionContent,
  assertBaseline = assertProductionDeploymentBaseline,
  uploadVersion = uploadExactVersion,
  activateVersion = activateExactVersion,
} = {}) {
  assertHead();
  await authorizeContent();
  await assertBaseline();
  assertSource({ assertHead });
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
