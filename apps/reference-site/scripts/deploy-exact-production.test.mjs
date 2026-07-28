import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import {
  createServer,
  request as createHttpRequest,
} from "node:http";
import { describe, expect, it, vi } from "vitest";

import {
  activateExactVersion,
  assertProductionDeploymentAbsent,
  assertProductionDeploymentBaseline,
  deployExactProduction,
  uploadExactVersion,
} from "./deploy-exact-production.mjs";
import { assertExactProductionSource } from "./assert-exact-production-head.mjs";

const versionId = "12345678-1234-1234-1234-123456789abc";
const previousVersionId =
  "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const commitSha = "c".repeat(40);
const exactActivationBody = JSON.stringify({
  strategy: "percentage",
  versions: [{ version_id: versionId, percentage: 100 }],
});
const activationEnvironment = {
  FOUNDRY_CLOUDFLARE_ACCOUNT_ID: "a",
  FOUNDRY_CLOUDFLARE_SCRIPT_NAME: "site",
};

function activate(options) {
  return activateExactVersion({
    environment: activationEnvironment,
    ...options,
  });
}

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

function deploymentHistoryResult(deployments) {
  return {
    success: true,
    result: {
      deployments: deployments.map(
        ({ id, versionId: deployedVersionId }) => ({
          id,
          versions: [
            { version_id: deployedVersionId, percentage: 100 },
          ],
        }),
      ),
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

function requestLoopback(url, { body, method = "GET" } = {}) {
  return new Promise((resolve, reject) => {
    const request = createHttpRequest(
      url,
      {
        method,
        headers: {
          connection: "close",
          ...(body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          resolve(response.statusCode);
        });
      },
    );
    request.once("error", reject);
    request.end(body);
  });
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
    const assertSource = vi.fn(({ assertHead: recheckHead }) => {
      recheckHead();
    });
    const authorizeContent = vi.fn().mockResolvedValue(undefined);
    const assertBaseline = vi.fn().mockResolvedValue(undefined);
    const uploadVersion = vi.fn().mockResolvedValue(versionId);
    const activateVersion = vi.fn().mockResolvedValue(undefined);

    await deployExactProduction({
      assertHead,
      assertSource,
      authorizeContent,
      assertBaseline,
      uploadVersion,
      activateVersion,
    });

    expect(uploadVersion).toHaveBeenCalledOnce();
    expect(authorizeContent).toHaveBeenCalledOnce();
    expect(assertBaseline).toHaveBeenCalledOnce();
    expect(assertSource).toHaveBeenCalledWith({ assertHead });
    expect(activateVersion).toHaveBeenCalledWith({
      versionId,
      assertHead,
    });
    expect(assertHead).toHaveBeenCalledTimes(3);
  });

  it("rejects a source mutation introduced after preflight before upload", async () => {
    const assertHead = vi.fn();
    const uploadVersion = vi.fn().mockResolvedValue(versionId);
    const activateVersion = vi.fn().mockResolvedValue(undefined);
    let sourceDirty = false;

    await expect(
      deployExactProduction({
        assertHead,
        authorizeContent: vi.fn(async () => {
          sourceDirty = true;
        }),
        assertBaseline: vi.fn().mockResolvedValue(undefined),
        assertSource: ({ assertHead: recheckHead }) =>
          assertExactProductionSource({
            assertHead: recheckHead,
            readSourceStatus: () =>
              sourceDirty ? " M tracked-source.ts\n" : "",
          }),
        uploadVersion,
        activateVersion,
      }),
    ).rejects.toThrow("exact_build_source_dirty");

    expect(uploadVersion).not.toHaveBeenCalled();
    expect(activateVersion).not.toHaveBeenCalled();
    expect(assertHead).toHaveBeenCalledOnce();
  });

  it("fails before upload when no production deployment baseline exists", async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          success: true,
          result: { deployments: [] },
        }),
      );
    });
    const upstreamBaseUrl = await listen(upstream);

    await expect(
      assertProductionDeploymentBaseline({
        environment: {
          ...activationEnvironment,
          CLOUDFLARE_API_TOKEN: "token",
        },
        upstreamBaseUrl,
      }),
    ).rejects.toThrow("exact_activation_baseline_unavailable");

    await close(upstream);
  });

  it("treats Cloudflare's exact missing Worker script response as an absent baseline", async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          result: null,
          success: false,
          errors: [
            {
              code: 10007,
              message: "workers.api.error.script_not_found",
            },
          ],
          messages: [],
        }),
      );
    });
    const upstreamBaseUrl = await listen(upstream);

    try {
      await expect(
        assertProductionDeploymentAbsent({
          environment: {
            ...activationEnvironment,
            CLOUDFLARE_API_TOKEN: "token",
          },
          upstreamBaseUrl,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await close(upstream);
    }
  });

  it.each([
    {
      name: "an authentication failure",
      status: 401,
      body: {
        result: null,
        success: false,
        errors: [
          {
            code: 9109,
            message: "Invalid access token",
          },
        ],
        messages: [],
      },
    },
    {
      name: "another 404 response",
      status: 404,
      body: {
        result: null,
        success: false,
        errors: [
          {
            code: 7003,
            message: "Could not route to /workers/scripts/site/deployments",
          },
        ],
        messages: [],
      },
    },
    {
      name: "a provider failure",
      status: 500,
      body: {
        result: null,
        success: false,
        errors: [
          {
            code: 10000,
            message: "Authentication error",
          },
        ],
        messages: [],
      },
    },
  ])("fails closed for $name while checking first deployment", async ({
    body,
    status,
  }) => {
    const upstream = createServer((_request, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
    const upstreamBaseUrl = await listen(upstream);

    try {
      await expect(
        assertProductionDeploymentAbsent({
          environment: {
            ...activationEnvironment,
            CLOUDFLARE_API_TOKEN: "token",
          },
          upstreamBaseUrl,
        }),
      ).rejects.toThrow("exact_activation_deployment_lookup_failed");
    } finally {
      await close(upstream);
    }
  });

  it("ignores an ambient Cloudflare API base URL for production lookups", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(deploymentResult()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    try {
      await assertProductionDeploymentBaseline({
        environment: {
          ...activationEnvironment,
          CLOUDFLARE_API_BASE_URL: "https://attacker.invalid/client/v4",
          CLOUDFLARE_API_TOKEN: "sensitive-token",
        },
      });

      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(String(fetchSpy.mock.calls[0][0])).toBe(
        "https://api.cloudflare.com/client/v4/accounts/a/workers/scripts/site/deployments",
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("ignores an ambient Cloudflare API base URL while proxying activation", async () => {
    const upstreamUrls = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        upstreamUrls.push(String(input));
        return new Response(
          JSON.stringify(
            init?.method === "POST"
              ? activationResult()
              : deploymentResult(),
          ),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      });

    try {
      await activateExactVersion({
        versionId,
        assertHead: vi.fn(),
        environment: {
          ...activationEnvironment,
          CLOUDFLARE_API_BASE_URL: "https://attacker.invalid/client/v4",
        },
        startActivation: ({ localApiBaseUrl }) =>
          activationProcess(async () => {
            const endpoint =
              `${localApiBaseUrl}/accounts/a/workers/scripts/site/deployments`;
            expect(await requestLoopback(endpoint)).toBe(200);
            expect(
              await requestLoopback(endpoint, {
                method: "POST",
                body: exactActivationBody,
              }),
            ).toBe(200);
          }),
      });

      expect(upstreamUrls).toHaveLength(3);
      expect(
        upstreamUrls.every((url) =>
          url.startsWith("https://api.cloudflare.com/client/v4/"),
        ),
      ).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
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

    await activate({
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

    expect(assertHead).toHaveBeenCalledTimes(3);
    expect(requests).toEqual([
      "GET /client/v4/accounts/a/workers/scripts/site/deployments",
      "GET /client/v4/accounts/a/workers/scripts/site/deployments",
      "POST /client/v4/accounts/a/workers/scripts/site/deployments",
    ]);
    await close(upstream);
  });

  it("accepts a recorded exact activation after a later process failure", async () => {
    const upstream = createServer((request, response) => {
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

    await expect(
      activate({
        versionId,
        assertHead,
        upstreamBaseUrl,
        startActivation: ({ localApiBaseUrl }) => {
          const process = new EventEmitter();
          queueMicrotask(async () => {
            await loadDeploymentBaseline(localApiBaseUrl);
            const response = await fetch(
              `${localApiBaseUrl}/accounts/a/workers/scripts/site/deployments`,
              { method: "POST", body: exactActivationBody },
            );
            expect(response.status).toBe(200);
            process.emit("exit", 1, null);
          });
          return process;
        },
      }),
    ).resolves.toBeUndefined();

    expect(assertHead).toHaveBeenCalledTimes(3);
    await close(upstream);
  });

  it("awaits an in-flight activation after the child exits without reading the response", async () => {
    let acceptedActivations = 0;
    const upstream = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      if (request.method === "GET") {
        response.end(JSON.stringify(deploymentResult()));
        return;
      }
      acceptedActivations += 1;
      setTimeout(() => {
        response.end(JSON.stringify(activationResult()));
      }, 20);
    });
    const upstreamBaseUrl = await listen(upstream);
    const assertHead = vi.fn();

    await expect(
      activate({
        versionId,
        assertHead,
        upstreamBaseUrl,
        startActivation: ({ localApiBaseUrl }) => {
          const process = new EventEmitter();
          queueMicrotask(async () => {
            await loadDeploymentBaseline(localApiBaseUrl);
            const target = new URL(
              `${localApiBaseUrl}/accounts/a/workers/scripts/site/deployments`,
            );
            const request = createHttpRequest(
              target,
              {
                method: "POST",
                headers: {
                  connection: "close",
                  "content-type": "application/json",
                },
              },
              (response) => {
                response.resume();
              },
            );
            request.once("error", (error) => {
              process.emit("error", error);
            });
            request.once("socket", (socket) => {
              const exitImmediately = () => {
                process.emit("exit", 1, null);
              };
              if (socket.connecting) {
                socket.once("connect", exitImmediately);
              } else {
                exitImmediately();
              }
            });
            request.end(exactActivationBody);
          });
          return process;
        },
      }),
    ).resolves.toBeUndefined();

    expect(acceptedActivations).toBe(1);
    expect(assertHead).toHaveBeenCalledTimes(3);
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
      activate({
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

  it("rechecks the head after a delayed deployment baseline lookup", async () => {
    let deploymentReads = 0;
    let activationPosts = 0;
    let headMoved = false;
    const upstream = createServer((request, response) => {
      if (request.method === "GET") {
        deploymentReads += 1;
        if (deploymentReads === 2) {
          headMoved = true;
        }
      } else {
        activationPosts += 1;
      }
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
      activate({
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

    expect(assertHead).toHaveBeenCalledTimes(2);
    expect(deploymentReads).toBe(2);
    expect(activationPosts).toBe(0);
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
      activate({
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
      activate({
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

  it("bounds a partial activation body and forces the loopback proxy to shut down", async () => {
    let upstreamRequests = 0;
    const upstream = createServer((_request, response) => {
      upstreamRequests += 1;
      response.writeHead(500);
      response.end();
    });
    const upstreamBaseUrl = await listen(upstream);
    const startedAt = Date.now();

    await expect(
      activate({
        versionId,
        assertHead: vi.fn(),
        loopbackBodyTimeoutMs: 50,
        loopbackDrainTimeoutMs: 200,
        upstreamBaseUrl,
        startActivation: ({ localApiBaseUrl }) => {
          const process = new EventEmitter();
          queueMicrotask(() => {
            const target = new URL(
              `${localApiBaseUrl}/accounts/a/workers/scripts/site/deployments`,
            );
            const request = createHttpRequest(target, {
              method: "POST",
              headers: { "content-type": "application/json" },
            });
            request.once("error", () => undefined);
            request.once("socket", (socket) => {
              const sendPartialBody = () => {
                request.write('{"strategy":"percentage","versions":[');
                process.emit("exit", 1, null);
              };
              if (socket.connecting) {
                socket.once("connect", sendPartialBody);
              } else {
                sendPartialBody();
              }
            });
          });
          return process;
        },
      }),
    ).rejects.toThrow("exact_activation_body_timeout");

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(upstreamRequests).toBe(0);
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
      activate({
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

    expect(upstreamRequests).toBe(3);
    await close(upstream);
  });

  it("restores the previous deployment when the ref moves after activation", async () => {
    const requests = [];
    const deployments = [
      { id: "deployment-before", versionId: previousVersionId },
    ];
    const upstream = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: request.method, body });
      response.writeHead(200, { "content-type": "application/json" });
      if (request.method === "GET") {
        response.end(
          JSON.stringify(deploymentHistoryResult(deployments)),
        );
        return;
      }
      const postCount = requests.filter(
        ({ method }) => method === "POST",
      ).length;
      const id =
        postCount === 1
          ? "deployment-activated"
          : "deployment-rollback";
      const deployedVersionId =
        postCount === 1
          ? versionId
          : JSON.parse(body).versions[0].version_id;
      deployments.unshift({ id, versionId: deployedVersionId });
      response.end(JSON.stringify(activationResult(id)));
    });
    const upstreamBaseUrl = await listen(upstream);
    let headCheck = 0;
    const assertHead = vi.fn(() => {
      headCheck += 1;
      if (headCheck === 3) {
        throw new Error("exact_production_head_moved");
      }
    });

    await expect(
      activate({
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
      "GET",
      "POST",
      "GET",
      "POST",
      "GET",
    ]);
    expect(JSON.parse(requests[4].body)).toMatchObject({
      strategy: "percentage",
      versions: [
        { version_id: previousVersionId, percentage: 100 },
      ],
    });
    await close(upstream);
  });

  it("reconciles an accepted activation whose response was lost before applying the final head fence", async () => {
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutDurations = [];
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((milliseconds) => {
        timeoutDurations.push(milliseconds);
        return nativeTimeout(milliseconds);
      });
    const deployments = [
      { id: "deployment-before", versionId: previousVersionId },
    ];
    let postCount = 0;
    let activationHistoryReads = 0;
    let rollbackHistoryReads = 0;
    const upstream = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      if (request.method === "GET") {
        let visibleDeployments = deployments;
        if (postCount === 1 && activationHistoryReads < 2) {
          activationHistoryReads += 1;
          visibleDeployments = deployments.slice(1);
        } else if (postCount === 2 && rollbackHistoryReads < 2) {
          rollbackHistoryReads += 1;
          visibleDeployments = deployments.slice(1);
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify(deploymentHistoryResult(visibleDeployments)),
        );
        return;
      }
      postCount += 1;
      if (postCount === 1) {
        deployments.unshift({
          id: "deployment-accepted-without-response",
          versionId,
        });
        response.destroy();
        return;
      }
      deployments.unshift({
        id: "deployment-rollback",
        versionId: JSON.parse(body).versions[0].version_id,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(activationResult("deployment-rollback")));
    });
    const upstreamBaseUrl = await listen(upstream);
    let headCheck = 0;

    await expect(
      activate({
        versionId,
        assertHead: vi.fn(() => {
          headCheck += 1;
          if (headCheck === 3) {
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
            expect(response.status).toBe(502);
          }),
      }),
    ).rejects.toThrow("exact_production_head_moved");

    expect(postCount).toBe(2);
    expect(activationHistoryReads).toBe(2);
    expect(rollbackHistoryReads).toBe(2);
    expect(deployments[0]).toEqual({
      id: "deployment-rollback",
      versionId: previousVersionId,
    });
    expect(
      timeoutDurations.some((milliseconds) => milliseconds < 29_900),
    ).toBe(true);
    timeoutSpy.mockRestore();
    await close(upstream);
  });

  it("keeps the pre-activation baseline after a lost response and later deployment lookup", async () => {
    let now = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      // Advance quickly enough to keep the stale-baseline failure bounded,
      // while leaving a full request budget for the first reconciliation read.
      now += 5_000;
      return now;
    });
    const deployments = [
      { id: "deployment-before", versionId: previousVersionId },
    ];
    let postCount = 0;
    const upstream = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify(deploymentHistoryResult(deployments)),
        );
        return;
      }
      postCount += 1;
      if (postCount === 1) {
        deployments.unshift({
          id: "deployment-accepted-without-response",
          versionId,
        });
        response.destroy();
        return;
      }
      deployments.unshift({
        id: "deployment-rollback",
        versionId: JSON.parse(body).versions[0].version_id,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(activationResult("deployment-rollback")));
    });
    const upstreamBaseUrl = await listen(upstream);
    let headCheck = 0;

    try {
      await expect(
        activate({
          versionId,
          assertHead: vi.fn(() => {
            headCheck += 1;
            if (headCheck === 3) {
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
              expect(response.status).toBe(502);
              await loadDeploymentBaseline(localApiBaseUrl);
            }),
        }),
      ).rejects.toThrow("exact_production_head_moved");

      expect(postCount).toBe(2);
      expect(deployments[0]).toEqual({
        id: "deployment-rollback",
        versionId: previousVersionId,
      });
    } finally {
      nowSpy.mockRestore();
      await close(upstream);
    }
  });

  it("does not retry a lost rollback response after a newer deployment wins during delayed history visibility", async () => {
    const deployments = [
      { id: "deployment-before", versionId: previousVersionId },
    ];
    const newerVersionId =
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    let postCount = 0;
    let delayedHistoryReads = 0;
    const upstream = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      if (request.method === "GET") {
        const visibleDeployments =
          postCount === 2 && delayedHistoryReads < 2
            ? (delayedHistoryReads += 1, deployments.slice(2))
            : deployments;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify(deploymentHistoryResult(visibleDeployments)),
        );
        return;
      }
      postCount += 1;
      if (postCount === 1) {
        deployments.unshift({
          id: "deployment-activated",
          versionId,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(activationResult()));
        return;
      }
      if (postCount === 2) {
        deployments.unshift({
          id: "deployment-newer",
          versionId: newerVersionId,
        });
        deployments.unshift({
          id: "deployment-rollback-with-lost-response",
          versionId: JSON.parse(body).versions[0].version_id,
        });
        response.destroy();
        return;
      }
      const compensationId = "deployment-race-compensation";
      deployments.unshift({
        id: compensationId,
        versionId: JSON.parse(body).versions[0].version_id,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(activationResult(compensationId)));
    });
    const upstreamBaseUrl = await listen(upstream);
    let headCheck = 0;

    await expect(
      activate({
        versionId,
        assertHead: vi.fn(() => {
          headCheck += 1;
          if (headCheck === 3) {
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

    expect(postCount).toBe(3);
    expect(delayedHistoryReads).toBe(2);
    expect(deployments[0]).toEqual({
      id: "deployment-race-compensation",
      versionId: newerVersionId,
    });
    await close(upstream);
  });

  it("reconciles an applied 5xx rollback before compensating a newer racing deployment", async () => {
    const deployments = [
      { id: "deployment-before", versionId: previousVersionId },
    ];
    const newerVersionId =
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    let postCount = 0;
    let delayedHistoryReads = 0;
    const upstream = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      if (request.method === "GET") {
        const visibleDeployments =
          postCount === 2 && delayedHistoryReads < 2
            ? (delayedHistoryReads += 1, deployments.slice(2))
            : deployments;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify(deploymentHistoryResult(visibleDeployments)),
        );
        return;
      }
      postCount += 1;
      if (postCount === 1) {
        deployments.unshift({
          id: "deployment-activated",
          versionId,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(activationResult()));
        return;
      }
      if (postCount === 2) {
        deployments.unshift({
          id: "deployment-newer",
          versionId: newerVersionId,
        });
        deployments.unshift({
          id: "deployment-rollback-returned-5xx",
          versionId: JSON.parse(body).versions[0].version_id,
        });
        response.writeHead(500, {
          "content-type": "application/json",
        });
        response.end(
          JSON.stringify({
            success: false,
            errors: [{ code: 10000, message: "Unknown result." }],
          }),
        );
        return;
      }
      const compensationId = "deployment-5xx-race-compensation";
      deployments.unshift({
        id: compensationId,
        versionId: JSON.parse(body).versions[0].version_id,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(activationResult(compensationId)));
    });
    const upstreamBaseUrl = await listen(upstream);
    let headCheck = 0;

    await expect(
      activate({
        versionId,
        assertHead: vi.fn(() => {
          headCheck += 1;
          if (headCheck === 3) {
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

    expect(postCount).toBe(3);
    expect(delayedHistoryReads).toBe(2);
    expect(deployments[0]).toEqual({
      id: "deployment-5xx-race-compensation",
      versionId: newerVersionId,
    });
    await close(upstream);
  });

  it("does not roll back a deployment that a newer one superseded", async () => {
    const methods = [];
    let activated = false;
    const upstream = createServer((request, response) => {
      methods.push(request.method);
      response.writeHead(200, { "content-type": "application/json" });
      if (request.method === "GET") {
        response.end(
          JSON.stringify(
            !activated
              ? deploymentResult()
              : deploymentHistoryResult([
                  {
                    id: "deployment-newer",
                    versionId: previousVersionId,
                  },
                  {
                    id: "deployment-activated",
                    versionId,
                  },
                  {
                    id: "deployment-before",
                    versionId: previousVersionId,
                  },
                ]),
          ),
        );
        return;
      }
      activated = true;
      response.end(JSON.stringify(activationResult()));
    });
    const upstreamBaseUrl = await listen(upstream);
    let headCheck = 0;

    await expect(
      activate({
        versionId,
        assertHead: vi.fn(() => {
          headCheck += 1;
          if (headCheck === 3) {
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

    expect(methods).toEqual(["GET", "GET", "POST", "GET"]);
    await close(upstream);
  });

  it("restores a deployment that races the rollback lookup", async () => {
    const methods = [];
    const deployments = [
      { id: "deployment-before", versionId: previousVersionId },
    ];
    let postCount = 0;
    const newerVersionId =
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const upstream = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      methods.push(request.method);
      response.writeHead(200, { "content-type": "application/json" });
      if (request.method === "GET") {
        response.end(
          JSON.stringify(deploymentHistoryResult(deployments)),
        );
        return;
      }
      postCount += 1;
      if (postCount === 1) {
        deployments.unshift({
          id: "deployment-activated",
          versionId,
        });
        response.end(JSON.stringify(activationResult()));
        return;
      }
      if (postCount === 2) {
        deployments.unshift({
          id: "deployment-newer",
          versionId: newerVersionId,
        });
      }
      const restoredVersionId = JSON.parse(body).versions[0].version_id;
      const id = `deployment-compensation-${postCount}`;
      deployments.unshift({ id, versionId: restoredVersionId });
      response.end(JSON.stringify(activationResult(id)));
    });
    const upstreamBaseUrl = await listen(upstream);
    let headCheck = 0;

    await expect(
      activate({
        versionId,
        assertHead: vi.fn(() => {
          headCheck += 1;
          if (headCheck === 3) {
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

    expect(methods).toEqual([
      "GET",
      "GET",
      "POST",
      "GET",
      "POST",
      "GET",
      "GET",
      "POST",
      "GET",
    ]);
    expect(deployments[0]).toEqual({
      id: "deployment-compensation-3",
      versionId: newerVersionId,
    });
    await close(upstream);
  });

  it("requires a provisioned deployment baseline", async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          success: true,
          result: { deployments: [] },
        }),
      );
    });
    const upstreamBaseUrl = await listen(upstream);

    await expect(
      activate({
        versionId,
        assertHead: vi.fn(),
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
    ).rejects.toThrow("exact_activation_baseline_unavailable");

    await close(upstream);
  });

  it("rejects an activation for a different Worker target", async () => {
    let upstreamRequests = 0;
    const upstream = createServer((_request, response) => {
      upstreamRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(activationResult()));
    });
    const upstreamBaseUrl = await listen(upstream);

    await expect(
      activate({
        versionId,
        upstreamBaseUrl,
        startActivation: ({ localApiBaseUrl }) =>
          activationProcess(async () => {
            const response = await fetch(
              `${localApiBaseUrl}/accounts/a/workers/scripts/other/deployments`,
              { method: "POST", body: exactActivationBody },
            );
            expect(response.status).toBe(409);
          }),
      }),
    ).rejects.toThrow("exact_activation_target_invalid");

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
      activate({
        versionId,
        upstreamBaseUrl,
        startActivation: () => activationProcess(async () => undefined),
      }),
    ).rejects.toThrow("exact_version_activation_count_invalid:0");

    await close(upstream);
  });
});
