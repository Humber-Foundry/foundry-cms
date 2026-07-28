import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import {
  createServer,
  request as createHttpRequest,
} from "node:http";
import { describe, expect, it, vi } from "vitest";

import {
  activateExactVersion,
  deployExactProduction,
  uploadExactVersion,
} from "./deploy-exact-production.mjs";

const versionId = "12345678-1234-1234-1234-123456789abc";
const commitSha = "c".repeat(40);
const exactActivationBody = JSON.stringify({
  strategy: "percentage",
  versions: [{ version_id: versionId, percentage: 100 }],
});

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
            { method: "POST", body: exactActivationBody },
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
              { method: "POST", body: exactActivationBody },
            );
            expect(response.status).toBe(409);
          }),
      }),
    ).rejects.toThrow("exact_production_head_moved");

    expect(assertHead).toHaveBeenCalledOnce();
    expect(upstreamRequests).toBe(0);
    await close(upstream);
  });

  it.each([
    [
      "a different version",
      {
        strategy: "percentage",
        versions: [
          {
            version_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            percentage: 100,
          },
        ],
      },
    ],
    [
      "mixed traffic",
      {
        strategy: "percentage",
        versions: [
          { version_id: versionId, percentage: 50 },
          {
            version_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            percentage: 50,
          },
        ],
      },
    ],
  ])("rejects %s before forwarding", async (_label, payload) => {
    let upstreamRequests = 0;
    const upstream = createServer((_request, response) => {
      upstreamRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: true }));
    });
    const upstreamBaseUrl = await listen(upstream);

    await expect(
      activateExactVersion({
        versionId,
        assertHead: vi.fn(),
        upstreamBaseUrl,
        startActivation: ({ localApiBaseUrl }) =>
          activationProcess(async () => {
            const response = await fetch(
              `${localApiBaseUrl}/accounts/a/workers/scripts/site/deployments`,
              { method: "POST", body: JSON.stringify(payload) },
            );
            expect(response.status).toBe(409);
          }),
      }),
    ).rejects.toThrow("exact_activation_payload_invalid");

    expect(upstreamRequests).toBe(0);
    await close(upstream);
  });

  it("rechecks the head after receiving a delayed activation body", async () => {
    let upstreamRequests = 0;
    let headMoved = false;
    const upstream = createServer((_request, response) => {
      upstreamRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: true }));
    });
    const upstreamBaseUrl = await listen(upstream);
    const assertHead = vi.fn(() => {
      if (headMoved) {
        throw new Error("exact_production_head_moved");
      }
    });

    await expect(
      activateExactVersion({
        versionId,
        assertHead,
        upstreamBaseUrl,
        startActivation: ({ localApiBaseUrl }) =>
          activationProcess(
            () =>
              new Promise((resolve, reject) => {
                const target = new URL(
                  `${localApiBaseUrl}/accounts/a/workers/scripts/site/deployments`,
                );
                const request = createHttpRequest(
                  target,
                  {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                  },
                  (response) => {
                    response.resume();
                    response.once("end", () => {
                      expect(response.statusCode).toBe(409);
                      resolve();
                    });
                  },
                );
                request.once("error", reject);
                request.write(
                  '{"strategy":"percentage","versions":[',
                );
                setTimeout(() => {
                  headMoved = true;
                  request.end(
                    `{"version_id":"${versionId}","percentage":100}]}`,
                  );
                }, 20);
              }),
          ),
      }),
    ).rejects.toThrow("exact_production_head_moved");

    expect(assertHead).toHaveBeenCalledOnce();
    expect(upstreamRequests).toBe(0);
    await close(upstream);
  });

  it("rejects a repeated activation before forwarding it", async () => {
    let upstreamRequests = 0;
    const upstream = createServer((_request, response) => {
      upstreamRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: true }));
    });
    const upstreamBaseUrl = await listen(upstream);

    await expect(
      activateExactVersion({
        versionId,
        assertHead: vi.fn(),
        upstreamBaseUrl,
        startActivation: ({ localApiBaseUrl }) =>
          activationProcess(async () => {
            const endpoint =
              `${localApiBaseUrl}/accounts/a/workers/scripts/site/deployments`;
            const first = await fetch(endpoint, {
              method: "POST",
              body: exactActivationBody,
            });
            const second = await fetch(endpoint, {
              method: "POST",
              body: exactActivationBody,
            });
            expect(first.status).toBe(200);
            expect(second.status).toBe(409);
          }),
      }),
    ).rejects.toThrow("exact_activation_repeated");

    expect(upstreamRequests).toBe(1);
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
