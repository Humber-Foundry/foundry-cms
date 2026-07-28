export type ContentPublicationAttempt = Readonly<{
  body: string;
  idempotencyKey: string;
}>;

type Fetcher = typeof fetch;

export function contentPublicationCanRetry(publication: {
  status: string;
  detail: string | null;
  commitSha: string | null;
}) {
  return (
    publication.status === "failed" &&
    (publication.commitSha !== null ||
      /^git_reference_(?:not_advanced|result_unknown):[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(
        publication.detail ?? "",
      ))
  );
}

export function contentPublicationPollDelay(attempt: number) {
  const boundedAttempt = Math.min(
    Math.max(0, Number.isSafeInteger(attempt) ? attempt : 0),
    4,
  );
  return Math.min(2_500 * 2 ** boundedAttempt, 30_000);
}

async function send(
  attempt: ContentPublicationAttempt,
  mutationToken: string,
  fetcher: Fetcher,
) {
  const response = await fetcher("/api/foundry-cms/publications", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": attempt.idempotencyKey,
      "x-foundry-csrf": mutationToken,
    },
    body: attempt.body,
  });
  return { response, body: (await response.json()) as unknown };
}

export async function sendContentPublicationAttempt({
  attempt,
  mutationToken,
  fetcher = fetch,
}: {
  attempt: ContentPublicationAttempt;
  mutationToken: string;
  fetcher?: Fetcher;
}) {
  let result = await send(attempt, mutationToken, fetcher);
  if (
    result.response.status !== 403 ||
    typeof result.body !== "object" ||
    result.body === null ||
    !("error" in result.body) ||
    result.body.error !== "request_check_failed"
  ) {
    return { ...result, mutationToken };
  }
  const refresh = await fetcher("/api/foundry-cms/revisions", {
    cache: "no-store",
  });
  const refreshed: unknown = await refresh.json();
  if (
    !refresh.ok ||
    typeof refreshed !== "object" ||
    refreshed === null ||
    !("mutationToken" in refreshed) ||
    typeof refreshed.mutationToken !== "string"
  ) {
    throw new Error("content_publication_token_refresh_failed");
  }
  result = await send(attempt, refreshed.mutationToken, fetcher);
  return { ...result, mutationToken: refreshed.mutationToken };
}

export async function loadContentPublication({
  workspaceId,
  publicationId,
  fetcher = fetch,
}: {
  workspaceId: string;
  publicationId?: string;
  fetcher?: Fetcher;
}) {
  const query = new URLSearchParams({ workspaceId });
  if (publicationId !== undefined) {
    query.set("publicationId", publicationId);
  }
  const response = await fetcher(
    `/api/foundry-cms/publications?${query.toString()}`,
    { cache: "no-store" },
  );
  if (!response.ok) {
    throw new Error("content_publication_refresh_failed");
  }
  return (await response.json()) as unknown;
}

export async function loadContentPublicationHistory({
  fetcher = fetch,
}: {
  fetcher?: Fetcher;
} = {}) {
  const response = await fetcher(
    "/api/foundry-cms/publications?view=history",
    { cache: "no-store" },
  );
  if (!response.ok) {
    throw new Error("content_publication_history_failed");
  }
  return (await response.json()) as unknown;
}

export function restoreContentPublication({
  publicationId,
  mutationToken,
  idempotencyKey,
  fetcher = fetch,
}: {
  publicationId: string;
  mutationToken: string;
  idempotencyKey: string;
  fetcher?: Fetcher;
}) {
  return sendContentPublicationAttempt({
    attempt: {
      body: JSON.stringify({
        operation: "restore",
        sourcePublicationId: publicationId,
      }),
      idempotencyKey,
    },
    mutationToken,
    fetcher,
  });
}

export function refreshContentPublication({
  workspaceId,
  publicationId,
  mutationToken,
  fetcher = fetch,
}: {
  workspaceId: string;
  publicationId: string;
  mutationToken: string;
  fetcher?: Fetcher;
}) {
  return sendContentPublicationAttempt({
    attempt: {
      body: JSON.stringify({
        operation: "refresh",
        workspaceId,
        publicationId,
      }),
      idempotencyKey: crypto.randomUUID(),
    },
    mutationToken,
    fetcher,
  });
}
