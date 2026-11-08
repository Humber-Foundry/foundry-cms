/**
 * Ask for the Access team's keys with the URL, method and redirect mode a
 * deployed Worker uses, and confirm that Cloudflare refuses (ADR-0050).
 *
 * Cloudflare answers a team that does not exist with HTTP 404. The Worker
 * then cannot get the team's keys and answers 503. A run with no network
 * also makes the Worker answer 503, so a 503 alone proves nothing. This
 * request tells the two apart: it fails, and says the run had no network,
 * when it gets no answer at all.
 */
export async function confirmCloudflareRefusesTeam(
  keySetUrl,
  { fetch: fetchImpl = fetch } = {},
) {
  let response;
  try {
    response = await fetchImpl(keySetUrl, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new Error(
      "no_network:team_key_request_got_no_answer:" +
        `${error?.cause?.code ?? error?.name ?? "unknown"}`,
      { cause: error },
    );
  }
  await response.body?.cancel();

  if (response.headers.get("server") !== "cloudflare") {
    throw new Error(`team_key_answer_not_from_cloudflare:${response.status}`);
  }
  if (response.status !== 404) {
    throw new Error(`cloudflare_did_not_refuse_team:${response.status}`);
  }
  return { status: response.status };
}
