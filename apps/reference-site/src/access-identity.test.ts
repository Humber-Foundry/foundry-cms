import { errors, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import {
  AccessIdentityError,
  AccessIdentityUnavailableError,
  createCloudflareAccessKeySet,
  validateCloudflareAccessAssertion,
} from "./access-identity";

const issuer = "https://foundry.cloudflareaccess.com";
const audience = "reference-application-audience";
const now = new Date("2026-07-27T04:00:00.000Z");
let privateKey: CryptoKey;
let keySet: ReturnType<typeof createCloudflareAccessKeySet>;

beforeAll(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  privateKey = keys.privateKey;
  const publicJwk = await exportJWK(keys.publicKey);
  keySet = createCloudflareAccessKeySet({
    keys: [{ ...publicJwk, kid: "key-1", alg: "RS256", use: "sig" }],
  });
});

async function createAssertion(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const issuedAt =
    typeof overrides.iat === "number"
      ? overrides.iat
      : Math.floor(now.getTime() / 1_000);
  const notBefore =
    typeof overrides.nbf === "number"
      ? overrides.nbf
      : Math.floor(now.getTime() / 1_000) - 1;
  const expiration =
    typeof overrides.exp === "number"
      ? overrides.exp
      : Math.floor(now.getTime() / 1_000) + 300;
  return new SignJWT({
    email:
      "email" in overrides
        ? overrides.email
        : " Owner@Example.com ",
    type: overrides.type ?? "app",
    identity_nonce: overrides.identity_nonce ?? "access-nonce",
  })
    .setProtectedHeader({ alg: "RS256", kid: "key-1" })
    .setIssuer(typeof overrides.iss === "string" ? overrides.iss : issuer)
    .setSubject("access-subject")
    .setAudience(
      typeof overrides.aud === "string" ? overrides.aud : audience,
    )
    .setIssuedAt(issuedAt)
    .setNotBefore(notBefore)
    .setExpirationTime(expiration)
    .sign(privateKey);
}

describe("Cloudflare Access identity validation", () => {
  it("returns only the normalized verified identity from a valid app assertion", async () => {
    await expect(
      validateCloudflareAccessAssertion({
        assertion: await createAssertion(),
        configuration: { issuer, audience },
        keySet,
        now,
      }),
    ).resolves.toEqual({
      binding: {
        issuer,
        subject: "access-subject",
      },
      email: "owner@example.com",
      nonce: "access-nonce",
    });
  });

  it.each([
    ["wrong issuer", { iss: "https://other.cloudflareaccess.com" }],
    ["wrong audience", { aud: "other-application" }],
    ["non-application token", { type: "org" }],
    ["missing email", { email: undefined }],
    ["future issued-at", { iat: Math.floor(now.getTime() / 1_000) + 61 }],
  ])("fails closed for %s", async (_label, overrides) => {
    await expect(
      validateCloudflareAccessAssertion({
        assertion: await createAssertion(overrides),
        configuration: { issuer, audience },
        keySet,
        now,
      }),
    ).rejects.toBeInstanceOf(AccessIdentityError);
  });

  it("fails closed for an expired assertion", async () => {
    await expect(
      validateCloudflareAccessAssertion({
        assertion: await createAssertion({
          exp: Math.floor(now.getTime() / 1_000) - 61,
        }),
        configuration: { issuer, audience },
        keySet,
        now,
      }),
    ).rejects.toBeInstanceOf(AccessIdentityError);
  });

  it.each([
    "Expected 200 OK from the JSON Web Key Set HTTP response",
    "Failed to parse the JSON Web Key Set HTTP response as JSON",
  ])("reports a remote JWKS service failure as unavailable", async (message) => {
    await expect(
      validateCloudflareAccessAssertion({
        assertion: await createAssertion(),
        configuration: { issuer, audience },
        keySet: async () => {
          throw new errors.JOSEError(message);
        },
        now,
      }),
    ).rejects.toBeInstanceOf(AccessIdentityUnavailableError);
  });
});
