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
const previousVersionId =
  "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
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

function deploymentResult(
  id = "deployment-before",
  deployedVersionId = previousVersionId,
) {
  return {
    success: true,
    result: {
      deployments: [
        {
          id,
          versions: [
            { version_id: deployedVersionId, percentage: 100 },
          ],
        },
      ],
    },
  };
}

function activationResult(id = "deployment-activated") {
  return { success: true, result: { id } };
}

async function loadDeploymentBaseline(localApiBaseUrl) {
  const response = await fetch(
    `${localApiBaseUrl}/accounts/a/workers/scripts/site/deployments`,
  );
  expect(response.status).toBe(200);
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
    const authorizeContent = vi.fn().mockResolvedValue(undefined);
    const uploadVersion = vi.fn().mockResolvedValue(versionId);
    const activateVersion = vi.fn().mockResolvedValue(undefined);

    await deployExactProduction({
      assertHead,
      authorizeContent,
      uploadVersion,
      activateVersion,
    });

    expect(uploadVersion).toHaveBeenCalledOnce();
    expect(authorizeContent).toHaveBeenCalledOnce();
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
      response.end(
        JSON.stringify(
          request.method === "GET"
            ? deploymentResult()
            : activationResult(),
        ),
      );
    });
    const upstreamBaseUrl = await listen(upstream);
    const assertHead = vi.fn();

    await activateExactVersion({
      versionId,
      assertHead,
      upstreamBaseUrl,
      startActivation: ({ localApiBaseUrl }) =>
        activationProcess(async () => {
          await loadDeploymentBaseline(localApiBaseUrl);
          const response = await fetch(
            `${localApiBaseUrl}/accounts/a/workers/scripts/site/deployments`,
            { method: "POST", body: exactActivationBody },
          );
          expect(response.status).toBe(200);
        }),
    });

    expect(assertHead).toHaveBeenCalledTimes(2);
    expect(requests).toEqual([
      "GET /client/v4/accounts/a/workers/scripts/site/deployments",
      "POST /client/v4/accounts/a/workers/scripts/site/deployments",
    ]);
    await close(upstream);
  });

  it("blocks activation when the protected ref advances at promotion", async () => {
    let upstreamRequests = 0;
    const upstream = createServer((request, response) => {
      upstreamRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          request.method === "GET"
            ? deploymentResult()
            : activationResult(),
        ),
      );
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
            await loadDeploymentBaseline(localApiBaseUrl);
            const response = await fetch(
              `${localApiBaseUrl}/accounts/a/workers/scripts/site/deployments`,
              { method: "POST", body: exactActivationBody },
            );
            expect(response.status).toBe(409);
          }),
      }),
    ).rejects.toThrow("exact_production_head_moved");

    expect(assertHead).toHaveBeenCalledOnce();
    expect(upstreamRequests).toBe(1);
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
    const upstream = createServer((request, response) => {
      upstreamRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          request.method === "GET"
            ? deploymentResult()
            : activationResult(),
        ),
      );
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
    const upstream = createServer((request, response) => {
      upstreamRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          request.method === "GET"
            ? deploymentResult()
            : activationResult(),
        ),
      );
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
            async () => {
              await loadDeploymentBaseline(localApiBaseUrl);
              return new Promise((resolve, reject) => {
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
              });
            },
          ),
      }),
    ).rejects.toThrow("exact_production_head_moved");

    expect(assertHead).toHaveBeenCalledOnce();
    expect(upstreamRequests).toBe(1);
    await close(upstream);
  });

  it("rejects a repeated activation before forwarding it", async () => {
    let upstreamRequests = 0;
    const upstream = createServer((request, response) => {
      upstreamRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          request.method === "GET"
            ? deploymentResult()
            : activationResult(),
        ),
      );
    });
    const upstreamBaseUrl = await listen(upstream);

    await expect(
      activateExactVersion({
        versionId,
        assertHead: vi.fn(),
        upstreamBaseUrl,
        startActivation: ({ localApiBaseUrl }) =>
          activationProcess(async () => {
            await loadDeploymentBaseline(localApiBaseUrl);
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

    expect(upstreamRequests).toBe(2);
    await close(upstream);
  });

  it("restores the previous deployment when the ref moves after activation", async () => {
    const requests = [];
    let lookupCount = 0;
    const upstream = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: request.method, body });
      response.writeHead(200, { "content-type": "application/json" });
      if (request.method === "GET") {
        lookupCount += 1;
        response.end(
          JSON.stringify(
            lookupCount === 1
              ? deploymentResult()
              : deploymentResult(
                  "deployment-activated",
                  versionId,
                ),
          ),
        );
        return;
      }
      response.end(
        JSON.stringify(
          requests.filter(({ method }) => method === "POST").length ===
            1
            ? activationResult()
            : activationResult("deployment-rollback"),
        ),
      );
    });
    const upstreamBaseUrl = await listen(upstream);
    let headCheck = 0;
    const assertHead = vi.fn(() => {
      headCheck += 1;
      if (headCheck === 2) {
        throw new Error("exact_production_head_moved");
      }
    });

    await expect(
      activateExactVersion({
        versionId,
        assertHead,
        upstreamBaseUrl,
        startActivation: ({ localApiBaseUrl }) =>
          activationProcess(async () => {
            await loadDeploymentBaseline(localApiBaseUrl);
            const response = await fetch(
              `${localApiBaseUrl}/accounts/a/workers/scripts/site/deployments`,
              { method: "POST", body: exactActivationBody },
            );
            expect(response.status).toBe(200);
          }),
      }),
    ).rejects.toThrow("exact_production_head_moved");

    expect(requests.map(({ method }) => method)).toEqual([
      "GET",
      "POST",
      "GET",
      "POST",
    ]);
    expect(JSON.parse(requests[3].body)).toMatchObject({
      strategy: "percentage",
      versions: [
        { version_id: previousVersionId, percentage: 100 },
      ],
    });
    await close(upstream);
  });

  it("does not roll back a deployment that a newer one superseded", async () => {
    let lookupCount = 0;
    const methods = [];
    const upstream = createServer((request, response) => {
      methods.push(request.method);
      response.writeHead(200, { "content-type": "application/json" });
      if (request.method === "GET") {
        lookupCount += 1;
        response.end(
          JSON.stringify(
            lookupCount === 1
              ? deploymentResult()
              : deploymentResult(
                  "deployment-newer",
                  previousVersionId,
                ),
          ),
        );
        return;
      }
      response.end(JSON.stringify(activationResult()));
    });
    const upstreamBaseUrl = await listen(upstream);
    let headCheck = 0;

    await expect(
      activateExactVersion({
        versionId,
        assertHead: vi.fn(() => {
          headCheck += 1;
          if (headCheck === 2) {
            throw new Error("exact_production_head_moved");
          }
        }),
        upstreamBaseUrl,
        startActivation: ({ localApiBaseUrl }) =>
          activationProcess(async () => {
            await loadDeploymentBaseline(localApiBaseUrl);
            const response = await fetch(
              `${localApiBaseUrl}/accounts/a/workers/scripts/site/deployments`,
              { method: "POST", body: exactActivationBody },
            );
            expect(response.status).toBe(200);
          }),
      }),
    ).rejects.toThrow("exact_production_head_moved");

    expect(methods).toEqual(["GET", "POST", "GET"]);
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
