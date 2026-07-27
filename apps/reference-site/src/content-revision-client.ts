export type ContentRevisionAttempt = Readonly<{
  body: string;
  idempotencyKey: string;
}>;

type Fetcher = typeof fetch;

async function send(
  attempt: ContentRevisionAttempt,
  mutationToken: string,
  fetcher: Fetcher,
) {
  const response = await fetcher("/api/foundry-cms/revisions", {
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

export async function sendContentRevisionAttempt({
  attempt,
  mutationToken,
  fetcher = fetch,
}: {
  attempt: ContentRevisionAttempt;
  mutationToken: string;
  fetcher?: Fetcher;
}) {
  let result = await send(attempt, mutationToken, fetcher);
  const { response, body } = result;
  if (
    response.status !== 403 ||
    typeof body !== "object" ||
    body === null ||
    !("error" in body) ||
    body.error !== "request_check_failed"
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
    throw new Error("content_revision_token_refresh_failed");
  }
  mutationToken = refreshed.mutationToken;
  result = await send(attempt, mutationToken, fetcher);
  return { ...result, mutationToken };
}
