import type { D1DatabaseBinding } from "./d1-human-access-store";

type Query = Readonly<{
  sql: string;
  params: ReadonlyArray<unknown>;
}>;

type QueryResult = Readonly<{
  success: boolean;
  meta: Readonly<{ changes?: number }>;
  results?: ReadonlyArray<unknown>;
}>;

type PreparedStatement = ReturnType<D1DatabaseBinding["prepare"]>;

const statementQuery = new WeakMap<object, Query>();

function normalizeParameter(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  throw new Error("d1_rest_parameter_invalid");
}

function queryFor(statement: PreparedStatement) {
  const query = statementQuery.get(statement);
  if (query === undefined) throw new Error("d1_rest_statement_invalid");
  return query;
}

export function createD1RestDatabase({
  accountId,
  databaseId,
  apiToken,
  fetchImplementation = fetch,
}: {
  accountId: string;
  databaseId: string;
  apiToken: string;
  fetchImplementation?: typeof fetch;
}): D1DatabaseBinding {
  if (
    accountId.length === 0 ||
    databaseId.length === 0 ||
    apiToken.length === 0
  ) {
    throw new Error("d1_rest_configuration_invalid");
  }

  async function execute(queries: ReadonlyArray<Query>) {
    const response = await fetchImplementation(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          // Cloudflare's D1 /query API accepts either D1SingleQuery or the
          // documented MultipleQueries { batch } request. Keep the latter so
          // recovery promotion and cleanup retain D1 batch atomicity.
          // https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/
          queries.length === 1 ? queries[0] : { batch: queries },
        ),
      },
    );
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error("d1_rest_response_invalid");
    }
    if (
      !response.ok ||
      typeof body !== "object" ||
      body === null ||
      !("success" in body) ||
      body.success !== true ||
      !("result" in body) ||
      !Array.isArray(body.result) ||
      body.result.length !== queries.length
    ) {
      throw new Error("d1_rest_query_failed");
    }
    const results = body.result as QueryResult[];
    if (results.some((result) => result.success !== true)) {
      throw new Error("d1_rest_query_failed");
    }
    return results;
  }

  function prepare(sql: string): PreparedStatement {
    function createStatement(params: ReadonlyArray<unknown>) {
      const statement: PreparedStatement = {
        bind(...values) {
          return createStatement(values.map(normalizeParameter));
        },
        async first<T>() {
          const result = (await execute([{ sql, params }]))[0];
          return (result?.results?.[0] as T | undefined) ?? null;
        },
        async all<T>() {
          const result = (await execute([{ sql, params }]))[0];
          return { results: [...(result?.results ?? [])] as T[] };
        },
        async run() {
          const result = (await execute([{ sql, params }]))[0];
          if (result === undefined) throw new Error("d1_rest_query_failed");
          return result;
        },
      };
      statementQuery.set(statement, { sql, params });
      return statement;
    }
    return createStatement([]);
  }

  return {
    prepare,
    batch(statements) {
      return execute(statements.map(queryFor));
    },
  };
}
