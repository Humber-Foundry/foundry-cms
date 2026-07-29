/**
 * `ResourceOperations` over Cloudflare's D1 REST API.
 *
 * This is the seam where reconciliation meets a real client account. The
 * adapter never holds a credential: the caller supplies an `authorize` hook
 * that adds the request's authorization header, so no token becomes a field on
 * this object, an argument to a function, or part of anything the redactor
 * could be asked to print.
 *
 * The installation marker lives in a row of the database itself, because a D1
 * database carries no provider-side description field. Reading that row back is
 * how a later run proves the database belongs to this installation rather than
 * merely sharing its name.
 */

import { OperatorError } from "./operator-errors";
import type {
  ProviderResourceCandidate,
  ResourceOperations,
} from "./resource-reconciliation";

export const cloudflareApiBase = "https://api.cloudflare.com/client/v4";

export const installationMarkerTable = "foundry_installation_marker";

export class CloudflareRequestError extends OperatorError {
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.status = status;
  }
}

export type CloudflareAuthorize = (
  headers: Headers,
) => Promise<void> | void;

type CloudflareResponse<T> = {
  success?: boolean;
  result?: T;
};

type D1DatabaseSummary = {
  uuid?: string;
  name?: string;
  created_at?: string;
  read_replication?: { mode?: string };
};

type D1QueryResult = {
  results?: ReadonlyArray<Record<string, unknown>>;
};

const requestTimeoutMilliseconds = 30_000;

export function createCloudflareD1Operations({
  accountId,
  authorize,
  installationId,
  deploymentId,
  primaryLocationHint,
  fetchImplementation = fetch,
  apiBase = cloudflareApiBase,
}: {
  accountId: string;
  authorize: CloudflareAuthorize;
  installationId: string;
  deploymentId: string;
  /**
   * A create-time placement hint. It is deliberately not part of the reconciled
   * configuration, because Cloudflare never reports it back.
   */
  primaryLocationHint?: string;
  fetchImplementation?: typeof fetch;
  apiBase?: string;
}): ResourceOperations {
  async function request<T>(
    path: string,
    init: { method: string; body?: unknown },
  ): Promise<T> {
    const headers = new Headers({ accept: "application/json" });
    if (init.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    await authorize(headers);

    let response: Response;
    try {
      response = await fetchImplementation(`${apiBase}${path}`, {
        method: init.method,
        headers,
        ...(init.body === undefined
          ? {}
          : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(requestTimeoutMilliseconds),
      });
    } catch {
      throw new CloudflareRequestError("cloudflare_request_unreachable", 0);
    }

    const payload = (await response
      .json()
      .catch(() => null)) as CloudflareResponse<T> | null;

    if (!response.ok || payload === null || payload.success !== true) {
      // Provider prose is deliberately dropped: only a stable code and the HTTP
      // status cross this boundary.
      throw new CloudflareRequestError(
        "cloudflare_request_failed",
        response.status,
      );
    }
    return payload.result as T;
  }

  async function query(
    databaseId: string,
    sql: string,
    params: ReadonlyArray<string> = [],
  ): Promise<ReadonlyArray<Record<string, unknown>>> {
    const result = await request<ReadonlyArray<D1QueryResult>>(
      `/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(
        databaseId,
      )}/query`,
      { method: "POST", body: { sql, params: [...params] } },
    );
    return result[0]?.results ?? [];
  }

  /**
   * Reads the marker, distinguishing "this database has no marker table" from
   * "the provider did not answer". Only the first is unmarked; an
   * authentication failure, rate limit or outage must surface as a retryable
   * provider failure, never as an ambiguous ownership claim.
   */
  async function readMarker(
    databaseId: string,
  ): Promise<{ installationId: string | null; deploymentId: string | null }> {
    const tables = await query(
      databaseId,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [installationMarkerTable],
    );
    if (tables.length === 0) {
      return { installationId: null, deploymentId: null };
    }

    const rows = await query(
      databaseId,
      `SELECT installation_id, deployment_id FROM ${installationMarkerTable} LIMIT 1`,
    );
    const row = rows[0];
    return {
      installationId:
        typeof row?.installation_id === "string" ? row.installation_id : null,
      deploymentId:
        typeof row?.deployment_id === "string" ? row.deployment_id : null,
    };
  }

  /**
   * Only fields Cloudflare returns on a database read may take part in the
   * fingerprint. `primary_location_hint` is a create-time hint that no read
   * echoes back, so fingerprinting it would make every fresh database fail its
   * own verification.
   */
  function observedConfiguration(summary: D1DatabaseSummary): unknown {
    return {
      kind: "d1",
      name: summary.name ?? "",
      readReplication: summary.read_replication?.mode ?? "disabled",
    };
  }

  async function toCandidate(
    summary: D1DatabaseSummary,
  ): Promise<ProviderResourceCandidate> {
    const databaseId = summary.uuid ?? "";
    const marker = await readMarker(databaseId);
    return Object.freeze({
      providerResourceId: databaseId,
      displayName: summary.name ?? "",
      installationMarker: marker.installationId,
      deploymentMarker: marker.deploymentId,
      configuration: observedConfiguration(summary),
      createdAt: summary.created_at ?? null,
      // D1 exposes no create-request identity, so an ambiguous create can never
      // be adopted automatically — only through the documented client-approved
      // resolution.
      createRequestId: null,
    });
  }

  return Object.freeze({
    async findByProviderResourceId(providerResourceId: string) {
      try {
        const summary = await request<D1DatabaseSummary>(
          `/accounts/${encodeURIComponent(
            accountId,
          )}/d1/database/${encodeURIComponent(providerResourceId)}`,
          { method: "GET" },
        );
        return await toCandidate(summary);
      } catch (error) {
        if (
          error instanceof CloudflareRequestError &&
          error.status === 404
        ) {
          return null;
        }
        throw error;
      }
    },

    async findByName(resourceName: string) {
      const summaries = await request<ReadonlyArray<D1DatabaseSummary>>(
        `/accounts/${encodeURIComponent(
          accountId,
        )}/d1/database?name=${encodeURIComponent(resourceName)}`,
        { method: "GET" },
      );
      // Cloudflare's name filter is a prefix search, so only exact matches are
      // candidates for this deterministic name.
      const exact = summaries.filter(
        (summary) => summary.name === resourceName,
      );
      return Object.freeze(await Promise.all(exact.map(toCandidate)));
    },

    async create({ resourceName }) {
      const summary = await request<D1DatabaseSummary>(
        `/accounts/${encodeURIComponent(accountId)}/d1/database`,
        {
          method: "POST",
          body: {
            name: resourceName,
            ...(primaryLocationHint === undefined
              ? {}
              : { primary_location_hint: primaryLocationHint }),
          },
        },
      );
      return toCandidate(summary);
    },

    async patch({ candidate, configuration }) {
      const desired = configuration as { readReplication?: string };
      await request<D1DatabaseSummary>(
        `/accounts/${encodeURIComponent(
          accountId,
        )}/d1/database/${encodeURIComponent(candidate.providerResourceId)}`,
        {
          method: "PATCH",
          body: {
            read_replication: { mode: desired.readReplication ?? "disabled" },
          },
        },
      );
      const summary = await request<D1DatabaseSummary>(
        `/accounts/${encodeURIComponent(
          accountId,
        )}/d1/database/${encodeURIComponent(candidate.providerResourceId)}`,
        { method: "GET" },
      );
      return toCandidate(summary);
    },

    async writeInstallationMarker(candidate) {
      await query(
        candidate.providerResourceId,
        `CREATE TABLE IF NOT EXISTS ${installationMarkerTable} (
           installation_id TEXT NOT NULL,
           deployment_id TEXT NOT NULL
         )`,
      );
      const existing = await readMarker(candidate.providerResourceId);
      if (
        existing.installationId !== null &&
        existing.installationId !== installationId
      ) {
        throw new CloudflareRequestError("cloudflare_marker_conflict", 409);
      }
      if (existing.installationId === null) {
        await query(
          candidate.providerResourceId,
          `INSERT INTO ${installationMarkerTable} (installation_id, deployment_id) VALUES (?, ?)`,
          [installationId, deploymentId],
        );
      }
      const summary = await request<D1DatabaseSummary>(
        `/accounts/${encodeURIComponent(
          accountId,
        )}/d1/database/${encodeURIComponent(candidate.providerResourceId)}`,
        { method: "GET" },
      );
      return toCandidate(summary);
    },

    async readBack(candidate) {
      const summary = await request<D1DatabaseSummary>(
        `/accounts/${encodeURIComponent(
          accountId,
        )}/d1/database/${encodeURIComponent(candidate.providerResourceId)}`,
        { method: "GET" },
      );
      return toCandidate(summary);
    },

    async healthCheck(candidate) {
      const passed: string[] = [];
      const rows = await query(
        candidate.providerResourceId,
        `SELECT installation_id FROM ${installationMarkerTable} LIMIT 1`,
      );
      if (rows[0]?.installation_id === installationId) {
        passed.push("d1.schema-ledger");
      }

      // A transactional write/read/delete canary against a table this
      // installation owns, proving the binding actually works.
      await query(
        candidate.providerResourceId,
        `CREATE TABLE IF NOT EXISTS foundry_provisioning_canary (id TEXT PRIMARY KEY)`,
      );
      await query(
        candidate.providerResourceId,
        `INSERT OR REPLACE INTO foundry_provisioning_canary (id) VALUES (?)`,
        [deploymentId],
      );
      const canary = await query(
        candidate.providerResourceId,
        `SELECT id FROM foundry_provisioning_canary WHERE id = ?`,
        [deploymentId],
      );
      await query(
        candidate.providerResourceId,
        `DELETE FROM foundry_provisioning_canary WHERE id = ?`,
        [deploymentId],
      );
      if (canary[0]?.id === deploymentId) {
        passed.push("d1.transaction-canary");
      }

      return {
        passed: passed.length === 2,
        checkIds: Object.freeze(passed),
      };
    },
  });
}
