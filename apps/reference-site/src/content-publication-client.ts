export type ContentPublicationAttempt = Readonly<{
  body: string;
  idempotencyKey: string;
}>;

type Fetcher = typeof fetch;

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

export async function refreshContentPublication({
  workspaceId,
  publicationId,
  fetcher = fetch,
}: {
  workspaceId: string;
  publicationId: string;
  fetcher?: Fetcher;
}) {
  const query = new URLSearchParams({ workspaceId, publicationId });
  const response = await fetcher(
    `/api/foundry-cms/publications?${query.toString()}`,
    { cache: "no-store" },
  );
  if (!response.ok) {
    throw new Error("content_publication_refresh_failed");
  }
  return (await response.json()) as unknown;
}
