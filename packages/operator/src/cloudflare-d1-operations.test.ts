import { describe, expect, it, vi } from "vitest";

import {
  CloudflareRequestError,
  cloudflareApiBase,
  createCloudflareD1Operations,
  installationMarkerTable,
} from "./cloudflare-d1-operations";

const accountId = "9f1c0a2b3d4e5f60718293a4b5c6d7e8";
const installationId = "01984f2a-1c00-7000-8000-0000000000aa";
const deploymentId = "01984f2a-1c00-7000-8000-0000000000bb";
const databaseId = "8f0b1c2d-3e4f-5061-7283-94a5b6c7d8e9";
const databaseName = "acme-marine-kmnpqrstuvwxyzab";

const summary = {
  uuid: databaseId,
  name: databaseName,
  created_at: "2026-07-27T00:05:00.000Z",
  read_replication: { mode: "disabled" },
};

function ok(result: unknown) {
  return new Response(JSON.stringify({ success: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function failure(status: number) {
  return new Response(
    JSON.stringify({
      success: false,
      errors: [{ code: 7003, message: "Could not route to /accounts/secret" }],
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

type Call = { url: string; method: string; body: unknown };

function createHarness({
  routes = {},
  markerRows = [{ installation_id: installationId, deployment_id: deploymentId }],
  markerTableMissing = false,
  primaryLocationHint,
}: {
  routes?: Record<string, () => Response>;
  markerRows?: ReadonlyArray<Record<string, unknown>> | null;
  markerTableMissing?: boolean;
  primaryLocationHint?: string;
} = {}) {
  const calls: Call[] = [];
  const authorized: string[] = [];

  const fetchImplementation = vi.fn(
    async (url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), method, body });
      authorized.push(
        new Headers(init?.headers).get("authorization") ?? "missing",
      );

      const key = `${method} ${String(url).replace(cloudflareApiBase, "")}`;
      const route = routes[key];
      if (route !== undefined) {
        return route();
      }
      if (method === "POST" && String(url).endsWith("/query")) {
        const sql = String((body as { sql?: string })?.sql ?? "");
        if (sql.startsWith("SELECT name FROM sqlite_master")) {
          if (markerRows === null) {
            return failure(500);
          }
          return ok([
            {
              results: markerTableMissing
                ? []
                : [{ name: installationMarkerTable }],
            },
          ]);
        }
        if (sql.includes(installationMarkerTable) && sql.startsWith("SELECT")) {
          return ok([{ results: markerRows ?? [] }]);
        }
        if (sql.startsWith("SELECT id FROM foundry_provisioning_canary")) {
          return ok([{ results: [{ id: deploymentId }] }]);
        }
        return ok([{ results: [] }]);
      }
      if (method === "GET" && String(url).includes("/d1/database?name=")) {
        return ok([summary]);
      }
      if (method === "GET" || method === "POST" || method === "PATCH") {
        return ok(summary);
      }
      return failure(404);
    },
  ) as unknown as typeof fetch;

  const operations = createCloudflareD1Operations({
    accountId,
    installationId,
    deploymentId,
    primaryLocationHint,
    authorize: (headers) => {
      headers.set("authorization", "Bearer client-provisioning-token");
    },
    fetchImplementation,
  });

  return { operations, calls, authorized };
}

describe("finding a database", () => {
  it("looks one up by its recorded provider id and reads its marker back", async () => {
    const { operations, calls } = createHarness();
    const candidate = await operations.findByProviderResourceId(databaseId);

    expect(candidate).toMatchObject({
      providerResourceId: databaseId,
      displayName: databaseName,
      installationMarker: installationId,
      deploymentMarker: deploymentId,
      configuration: {
        kind: "d1",
        name: databaseName,
        readReplication: "disabled",
      },
      createdAt: "2026-07-27T00:05:00.000Z",
    });
    expect(calls[0]?.url).toBe(
      `${cloudflareApiBase}/accounts/${accountId}/d1/database/${databaseId}`,
    );
  });

  it("returns null for a database that does not exist", async () => {
    const { operations } = createHarness({
      routes: {
        [`GET /accounts/${accountId}/d1/database/${databaseId}`]: () =>
          failure(404),
      },
    });

    expect(await operations.findByProviderResourceId(databaseId)).toBeNull();
  });

  it("keeps only exact name matches from Cloudflare's prefix search", async () => {
    const { operations } = createHarness({
      routes: {
        [`GET /accounts/${accountId}/d1/database?name=${databaseName}`]: () =>
          ok([summary, { ...summary, uuid: "other", name: `${databaseName}-2` }]),
      },
    });

    const found = await operations.findByName(databaseName);
    expect(found).toHaveLength(1);
    expect(found[0]?.providerResourceId).toBe(databaseId);
  });

  it("reports an empty marker table as unmarked rather than assuming ownership", async () => {
    const { operations } = createHarness({ markerRows: [] });
    const candidate = await operations.findByProviderResourceId(databaseId);

    expect(candidate?.installationMarker).toBeNull();
    expect(candidate?.deploymentMarker).toBeNull();
  });

  it("treats a database with no marker table as unmarked", async () => {
    const { operations } = createHarness({ markerTableMissing: true });
    const candidate = await operations.findByProviderResourceId(databaseId);

    expect(candidate?.installationMarker).toBeNull();
    expect(candidate?.deploymentMarker).toBeNull();
  });

  it("surfaces a provider failure rather than reporting the marker absent", async () => {
    const { operations } = createHarness({ markerRows: null });

    const error = await operations
      .findByProviderResourceId(databaseId)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CloudflareRequestError);
    expect((error as CloudflareRequestError).code).toBe(
      "cloudflare_request_failed",
    );
  });

  it("never claims a create-request binding D1 does not expose", async () => {
    const { operations } = createHarness();
    expect(
      (await operations.findByProviderResourceId(databaseId))?.createRequestId,
    ).toBeNull();
  });
});

describe("creating and repairing a database", () => {
  it("creates with the deterministic name and the configured placement hint", async () => {
    const { operations, calls } = createHarness({ primaryLocationHint: "weur" });
    await operations.create({
      resourceName: databaseName,
      configuration: { kind: "d1", name: databaseName },
    });

    const create = calls.find(
      (call) => call.method === "POST" && !call.url.endsWith("/query"),
    );
    expect(create?.url).toBe(
      `${cloudflareApiBase}/accounts/${accountId}/d1/database`,
    );
    expect(create?.body).toEqual({
      name: databaseName,
      primary_location_hint: "weur",
    });
  });

  it("keeps the placement hint out of the reconciled configuration", async () => {
    // Cloudflare never echoes the hint back, so fingerprinting it would make a
    // freshly created database fail its own readback.
    const { operations } = createHarness({ primaryLocationHint: "weur" });
    const created = await operations.create({
      resourceName: databaseName,
      configuration: { kind: "d1", name: databaseName },
    });

    expect(created.configuration).toEqual({
      kind: "d1",
      name: databaseName,
      readReplication: "disabled",
    });
    expect(JSON.stringify(created.configuration)).not.toContain("weur");
  });

  it("patches read replication and reads the result back", async () => {
    const { operations, calls } = createHarness();
    await operations.patch({
      candidate: {
        providerResourceId: databaseId,
        displayName: databaseName,
        installationMarker: installationId,
        deploymentMarker: deploymentId,
        configuration: {},
        createdAt: null,
        createRequestId: null,
      },
      drift: ["readReplication"],
      configuration: { readReplication: "enabled" },
    });

    const patch = calls.find((call) => call.method === "PATCH");
    expect(patch?.body).toEqual({ read_replication: { mode: "enabled" } });
    expect(
      calls.filter((call) => call.method === "GET"),
    ).not.toHaveLength(0);
  });
});

describe("the installation marker", () => {
  it("writes the marker into the database when none exists", async () => {
    const { operations, calls } = createHarness({ markerRows: [] });
    await operations.writeInstallationMarker({
      providerResourceId: databaseId,
      displayName: databaseName,
      installationMarker: null,
      deploymentMarker: null,
      configuration: {},
      createdAt: null,
      createRequestId: null,
    });

    const inserts = calls.filter((call) =>
      String((call.body as { sql?: string })?.sql ?? "").startsWith("INSERT"),
    );
    expect(inserts).toHaveLength(1);
    expect((inserts[0]?.body as { params?: string[] })?.params).toEqual([
      installationId,
      deploymentId,
    ]);
  });

  it("refuses to overwrite a marker for another installation", async () => {
    const { operations } = createHarness({
      markerRows: [
        {
          installation_id: "01984f2a-1c00-7000-8000-0000000000dd",
          deployment_id: deploymentId,
        },
      ],
    });

    await expect(
      operations.writeInstallationMarker({
        providerResourceId: databaseId,
        displayName: databaseName,
        installationMarker: null,
        deploymentMarker: null,
        configuration: {},
        createdAt: null,
        createRequestId: null,
      }),
    ).rejects.toThrow(/cloudflare_marker_conflict/u);
  });

  it("does not insert a second marker row when one already matches", async () => {
    const { operations, calls } = createHarness();
    await operations.writeInstallationMarker({
      providerResourceId: databaseId,
      displayName: databaseName,
      installationMarker: installationId,
      deploymentMarker: deploymentId,
      configuration: {},
      createdAt: null,
      createRequestId: null,
    });

    expect(
      calls.filter((call) =>
        String((call.body as { sql?: string })?.sql ?? "").startsWith("INSERT"),
      ),
    ).toHaveLength(0);
  });
});

describe("health", () => {
  it("passes only when both the marker and the transaction canary hold", async () => {
    const { operations, calls } = createHarness();
    const health = await operations.healthCheck({
      providerResourceId: databaseId,
      displayName: databaseName,
      installationMarker: installationId,
      deploymentMarker: deploymentId,
      configuration: {},
      createdAt: null,
      createRequestId: null,
    });

    expect(health).toEqual({
      passed: true,
      checkIds: ["d1.schema-ledger", "d1.transaction-canary"],
    });
    expect(
      calls.some((call) =>
        String((call.body as { sql?: string })?.sql ?? "").startsWith("DELETE"),
      ),
    ).toBe(true);
  });

  it("fails when the marker is for another installation", async () => {
    const { operations } = createHarness({
      markerRows: [
        {
          installation_id: "01984f2a-1c00-7000-8000-0000000000dd",
          deployment_id: deploymentId,
        },
      ],
    });

    const health = await operations.healthCheck({
      providerResourceId: databaseId,
      displayName: databaseName,
      installationMarker: null,
      deploymentMarker: null,
      configuration: {},
      createdAt: null,
      createRequestId: null,
    });

    expect(health.passed).toBe(false);
    expect(health.checkIds).toEqual(["d1.transaction-canary"]);
  });
});

describe("credential and provider-prose handling", () => {
  it("adds authorization through the hook and keeps no token of its own", async () => {
    const { operations, authorized } = createHarness();
    await operations.findByProviderResourceId(databaseId);

    expect(authorized[0]).toBe("Bearer client-provisioning-token");
    expect(JSON.stringify(operations)).not.toContain("client-provisioning-token");
    expect(Object.keys(operations)).not.toContain("token");
  });

  it("drops provider prose and raises a stable code with the status", async () => {
    const { operations } = createHarness({
      routes: {
        [`GET /accounts/${accountId}/d1/database?name=${databaseName}`]: () =>
          failure(403),
      },
    });

    const error = await operations
      .findByName(databaseName)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CloudflareRequestError);
    expect((error as CloudflareRequestError).code).toBe(
      "cloudflare_request_failed",
    );
    expect((error as CloudflareRequestError).status).toBe(403);
    expect((error as Error).message).not.toContain("Could not route");
  });

  it("reports an unreachable provider distinctly from a refusal", async () => {
    const operations = createCloudflareD1Operations({
      accountId,
      installationId,
      deploymentId,
      authorize: () => undefined,
      fetchImplementation: (async () => {
        throw new Error("ETIMEDOUT");
      }) as unknown as typeof fetch,
    });

    const error = await operations
      .findByName(databaseName)
      .catch((thrown: unknown) => thrown);

    expect((error as CloudflareRequestError).code).toBe(
      "cloudflare_request_unreachable",
    );
    expect((error as CloudflareRequestError).status).toBe(0);
  });
});
