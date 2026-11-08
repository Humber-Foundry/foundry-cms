import { describe, expect, it } from "vitest";

import { confirmCloudflareRefusesTeam } from "./cloudflare-team-refusal.mjs";

const keySetUrl =
  "https://foundry-harness-0123456789abcdef.cloudflareaccess.com/cdn-cgi/access/certs";

function answering(response) {
  const requests = [];
  return {
    requests,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      if (response instanceof Error) {
        throw response;
      }
      return response;
    },
  };
}

describe("confirming that Cloudflare refuses the harness's Access team", () => {
  it("reports Cloudflare's refusal of a team that does not exist", async () => {
    const network = answering(
      new Response("<title>Error ・ Cloudflare Access</title>", {
        status: 404,
        headers: { server: "cloudflare", "content-type": "text/html" },
      }),
    );

    await expect(
      confirmCloudflareRefusesTeam(keySetUrl, { fetch: network.fetch }),
    ).resolves.toBeUndefined();
    expect(network.requests).toHaveLength(1);
    expect(network.requests[0].url).toBe(keySetUrl);
    expect(network.requests[0].init.method).toBe("GET");
  });

  it("fails and says the run had no network when the request gets no answer", async () => {
    const network = answering(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), {
          code: "ENOTFOUND",
        }),
      }),
    );

    await expect(
      confirmCloudflareRefusesTeam(keySetUrl, { fetch: network.fetch }),
    ).rejects.toThrow("no_network_for_team_key_request:ENOTFOUND");
  });

  it("fails when something other than Cloudflare answers", async () => {
    const network = answering(
      new Response("blocked by proxy", {
        status: 404,
        headers: { server: "corporate-proxy" },
      }),
    );

    await expect(
      confirmCloudflareRefusesTeam(keySetUrl, { fetch: network.fetch }),
    ).rejects.toThrow("team_key_answer_not_from_cloudflare:404");
  });

  it.each([200, 403, 500, 503])(
    "fails when Cloudflare answers %i instead of refusing the team",
    async (status) => {
      const network = answering(
        new Response("{}", { status, headers: { server: "cloudflare" } }),
      );

      await expect(
        confirmCloudflareRefusesTeam(keySetUrl, { fetch: network.fetch }),
      ).rejects.toThrow(`cloudflare_did_not_refuse_team:${status}`);
    },
  );
});
