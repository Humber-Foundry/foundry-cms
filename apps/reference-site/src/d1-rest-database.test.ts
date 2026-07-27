import { describe, expect, it, vi } from "vitest";

import { createD1RestDatabase } from "./d1-rest-database";

function successfulResponse(...results: ReadonlyArray<unknown>) {
  return new Response(
    JSON.stringify({
      success: true,
      result: results.map((result) => ({
        success: true,
        meta: { changes: 0 },
        results: [result],
      })),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("D1 REST database", () => {
  it("sends bound single queries without exposing the token in the body", async () => {
    const fetchImplementation = vi.fn(async () =>
      successfulResponse({ id: "owner-48" }),
    );
    const database = createD1RestDatabase({
      accountId: "account-48",
      databaseId: "database-48",
      apiToken: "secret-token",
      fetchImplementation,
    });

    await expect(
      database
        .prepare("SELECT id FROM memberships WHERE id = ?1")
        .bind("owner-48")
        .first<{ id: string }>(),
    ).resolves.toEqual({ id: "owner-48" });

    const [url, request] = (
      fetchImplementation.mock.calls as unknown as Array<
        [string, RequestInit]
      >
    )[0] ?? ["", {}];
    expect(url).toContain("/accounts/account-48/d1/database/database-48/query");
    expect(request?.headers).toEqual({
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    });
    expect(request?.body).toBe(
      JSON.stringify({
        sql: "SELECT id FROM memberships WHERE id = ?1",
        params: ["owner-48"],
      }),
    );
    expect(request?.body).not.toContain("secret-token");
  });

  it("uses the transactional batch request shape", async () => {
    const fetchImplementation = vi.fn(async () =>
      successfulResponse({ changed: 1 }, { changed: 1 }),
    );
    const database = createD1RestDatabase({
      accountId: "account-48",
      databaseId: "database-48",
      apiToken: "secret-token",
      fetchImplementation,
    });
    await database.batch([
      database.prepare("INSERT INTO one VALUES (?1)").bind("one"),
      database
        .prepare("UPDATE two SET submission_count = ?1 WHERE id = ?2")
        .bind(48, "two"),
    ]);

    const [, request] = (
      fetchImplementation.mock.calls as unknown as Array<
        [string, RequestInit]
      >
    )[0] ?? ["", {}];
    expect(JSON.parse(String(request?.body))).toEqual({
      batch: [
        { sql: "INSERT INTO one VALUES (?1)", params: ["one"] },
        {
          sql: "UPDATE two SET submission_count = ?1 WHERE id = ?2",
          params: ["48", "two"],
        },
      ],
    });
  });

  it("rejects unsupported bind values before making a request", async () => {
    const fetchImplementation = vi.fn();
    const database = createD1RestDatabase({
      accountId: "account-48",
      databaseId: "database-48",
      apiToken: "secret-token",
      fetchImplementation,
    });
    expect(() => database.prepare("SELECT ?1").bind(null)).toThrow(
      "d1_rest_parameter_invalid",
    );
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("fails closed on unsuccessful or malformed API responses", async () => {
    const database = createD1RestDatabase({
      accountId: "account-48",
      databaseId: "database-48",
      apiToken: "secret-token",
      fetchImplementation: vi.fn(async () => new Response("unavailable", { status: 503 })),
    });
    await expect(database.prepare("SELECT 1").run()).rejects.toThrow(
      "d1_rest_response_invalid",
    );
  });
});
