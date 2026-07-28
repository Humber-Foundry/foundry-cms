import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";

import {
  activateExactVersion,
  deployExactProduction,
  uploadExactVersion,
} from "./deploy-exact-production.mjs";

const versionId = "12345678-1234-1234-1234-123456789abc";
const commitSha = "c".repeat(40);

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test_server_unavailable");
  }
  return `http://127.0.0.1:${address.port}/client/v4`;
}

async function close(server) {
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

function activationProcess(run) {
  const process = new EventEmitter();
  queueMicrotask(async () => {
    try {
      await run();
      process.emit("exit", 0, null);
    } catch (error) {
      process.emit("error", error);
    }
  });
  return process;
}

describe("guarded exact production deployment", () => {
  it("reads the exact non-serving version from Wrangler output", async () => {
    const uploaded = await uploadExactVersion({
      environment: { WORKERS_CI_COMMIT_SHA: commitSha },
      startUpload: ({ outputPath, expectedCommit }) =>
        activationProcess(async () => {
          expect(expectedCommit).toBe(commitSha);
          writeFileSync(
            outputPath,
            `${JSON.stringify({
              type: "version-upload",
              version: 1,
              version_id: versionId,
            })}\n`,
          );
        }),
    });

    expect(uploaded).toBe(versionId);
  });

  it("uploads without serving, then activates the exact version", async () => {
    const assertHead = vi.fn();
    const uploadVersion = vi.fn().mockResolvedValue(versionId);
    const activateVersion = vi.fn().mockResolvedValue(undefined);

    await deployExactProduction({
      assertHead,
      uploadVersion,
      activateVersion,
    });

    expect(uploadVersion).toHaveBeenCalledOnce();
    expect(activateVersion).toHaveBeenCalledWith({
      versionId,
      assertHead,
    });
    expect(assertHead).toHaveBeenCalledTimes(2);
  });

  it("checks the production ref at the actual activation request", async () => {
    const requests = [];
    const upstream = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: true, result: { id: "d1" } }));
    });
    const upstreamBaseUrl = await listen(upstream);
    const assertHead = vi.fn();

    await activateExactVersion({
      versionId,
      assertHead,
      upstreamBaseUrl,
      startActivation: ({ localApiBaseUrl }) =>
        activationProcess(async () => {
          const response = await fetch(
            `${localApiBaseUrl}/accounts/a/workers/scripts/site/deployments`,
            { method: "POST", body: "{}" },
          );
          expect(response.status).toBe(200);
        }),
    });

    expect(assertHead).toHaveBeenCalledTimes(2);
    expect(requests).toEqual([
      "POST /client/v4/accounts/a/workers/scripts/site/deployments",
    ]);
    await close(upstream);
  });

  it("blocks activation when the protected ref advances at promotion", async () => {
    let upstreamRequests = 0;
    const upstream = createServer((_request, response) => {
      upstreamRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: true }));
    });
    const upstreamBaseUrl = await listen(upstream);
    const assertHead = vi.fn(() => {
      throw new Error("exact_production_head_moved");
    });

    await expect(
      activateExactVersion({
        versionId,
        assertHead,
        upstreamBaseUrl,
        startActivation: ({ localApiBaseUrl }) =>
          activationProcess(async () => {
            const response = await fetch(
              `${localApiBaseUrl}/accounts/a/workers/scripts/site/deployments`,
              { method: "POST", body: "{}" },
            );
            expect(response.status).toBe(409);
          }),
      }),
    ).rejects.toThrow("exact_production_head_moved");

    expect(assertHead).toHaveBeenCalledOnce();
    expect(upstreamRequests).toBe(0);
    await close(upstream);
  });

  it("rejects an activation command that never promotes the version", async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: true }));
    });
    const upstreamBaseUrl = await listen(upstream);

    await expect(
      activateExactVersion({
        versionId,
        upstreamBaseUrl,
        startActivation: () => activationProcess(async () => undefined),
      }),
    ).rejects.toThrow("exact_version_activation_count_invalid:0");

    await close(upstream);
  });
});
