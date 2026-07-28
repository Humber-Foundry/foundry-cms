export type MediaMutationAttempt = Readonly<{
  body: BodyInit;
  idempotencyKey: string;
  contentType?: "application/json";
}>;

type Fetcher = typeof fetch;

async function responseBody(response: Response) {
  if (response.status === 204) return null;
  return response.json() as Promise<unknown>;
}

async function send(
  attempt: MediaMutationAttempt,
  mutationToken: string,
  fetcher: Fetcher,
) {
  const response = await fetcher("/api/foundry-cms/media", {
    method: "POST",
    headers: {
      ...(attempt.contentType === undefined
        ? {}
        : { "content-type": attempt.contentType }),
      "idempotency-key": attempt.idempotencyKey,
      "x-foundry-csrf": mutationToken,
    },
    body: attempt.body,
  });
  return { response, body: await responseBody(response) };
}

export async function sendMediaMutationAttempt({
  attempt,
  mutationToken,
  fetcher = fetch,
}: {
  attempt: MediaMutationAttempt;
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
    throw new Error("media_mutation_token_refresh_failed");
  }
  mutationToken = refreshed.mutationToken;
  result = await send(attempt, mutationToken, fetcher);
  return { ...result, mutationToken };
}
