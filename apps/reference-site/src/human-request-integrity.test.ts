import { describe, expect, it } from "vitest";

import {
  HumanRequestIntegrityError,
  createHumanCsrfToken,
  verifyHumanMutationRequest,
} from "./human-request-integrity";

const identity = {
  binding: {
    issuer: "https://foundry.cloudflareaccess.com",
    subject: "owner-subject",
  },
  email: "owner@example.com",
  nonce: "access-nonce",
};
const audience = "reference-audience";
const canonicalOrigin = "https://foundry.example";
const secret = "test-secret-with-at-least-24-characters";
const now = new Date("2026-07-27T04:00:00.000Z");

async function mutationRequest(overrides: {
  origin?: string;
  token?: string;
  contentType?: string;
}) {
  const token =
    overrides.token ??
    (await createHumanCsrfToken({
      identity,
      audience,
      secret,
      now,
    }));
  return new Request(`${canonicalOrigin}/api/foundry-cms/members`, {
    method: "POST",
    headers: {
      origin: overrides.origin ?? canonicalOrigin,
      "content-type": overrides.contentType ?? "application/json",
      "x-foundry-csrf": token,
    },
    body: "{}",
  });
}

describe("human mutation request integrity", () => {
  it("accepts same-origin JSON with a current identity-bound token", async () => {
    await expect(
      verifyHumanMutationRequest({
        request: await mutationRequest({}),
        identity,
        audience,
        canonicalOrigin,
        secret,
        now,
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["cross-origin request", { origin: "https://attacker.example" }],
    ["unexpected content", { contentType: "text/plain" }],
    ["invalid token", { token: "invalid.token" }],
  ])("rejects %s", async (_label, overrides) => {
    await expect(
      verifyHumanMutationRequest({
        request: await mutationRequest(overrides),
        identity,
        audience,
        canonicalOrigin,
        secret,
        now,
      }),
    ).rejects.toBeInstanceOf(HumanRequestIntegrityError);
  });

  it("rejects a token bound to a different Access identity nonce", async () => {
    const token = await createHumanCsrfToken({
      identity: { ...identity, nonce: "other-nonce" },
      audience,
      secret,
      now,
    });
    await expect(
      verifyHumanMutationRequest({
        request: await mutationRequest({ token }),
        identity,
        audience,
        canonicalOrigin,
        secret,
        now,
      }),
    ).rejects.toBeInstanceOf(HumanRequestIntegrityError);
  });
});
