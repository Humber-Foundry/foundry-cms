import {
  base64url,
  errors,
  exportJWK,
  exportSPKI,
  generateKeyPair,
  SignJWT,
  type JSONWebKeySet,
  type JWK,
  type JWTHeaderParameters,
} from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
let publicJwk: JWK;
let publicKeyPem: string;
let keySet: ReturnType<typeof createCloudflareAccessKeySet>;

/** A signing key pair, and its public key as the team's key set lists it. */
async function teamSigningKey(kid: string) {
  const keys = await generateKeyPair("RS256", { extractable: true });
  return {
    ...keys,
    jwk: {
      ...(await exportJWK(keys.publicKey)),
      kid,
      alg: "RS256",
      use: "sig",
    },
  };
}

beforeAll(async () => {
  const keys = await teamSigningKey("key-1");
  privateKey = keys.privateKey;
  publicJwk = keys.jwk;
  publicKeyPem = await exportSPKI(keys.publicKey);
  keySet = createCloudflareAccessKeySet({ keys: [publicJwk] });
});

async function createAssertion(
  overrides: Record<string, unknown> = {},
  signing: { header: JWTHeaderParameters; key: CryptoKey | Uint8Array } = {
    header: { alg: "RS256", kid: "key-1" },
    key: privateKey,
  },
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
    .setProtectedHeader(signing.header)
    .setIssuer(typeof overrides.iss === "string" ? overrides.iss : issuer)
    .setSubject("access-subject")
    .setAudience(
      typeof overrides.aud === "string" ? overrides.aud : audience,
    )
    .setIssuedAt(issuedAt)
    .setNotBefore(notBefore)
    .setExpirationTime(expiration)
    .sign(signing.key);
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

  it.each([
    [
      "an unsigned assertion (alg none)",
      async () => {
        const [, payload] = (await createAssertion()).split(".");
        const header = base64url.encode(
          JSON.stringify({ alg: "none", kid: "key-1" }),
        );
        return `${header}.${payload}.`;
      },
    ],
    [
      "an HS256 assertion signed with the public key as its secret",
      () =>
        createAssertion(
          {},
          {
            header: { alg: "HS256", kid: "key-1" },
            key: new TextEncoder().encode(publicKeyPem),
          },
        ),
    ],
    [
      "an assertion with no key id",
      () => createAssertion({}, { header: { alg: "RS256" }, key: privateKey }),
    ],
  ])("fails closed for %s", async (_label, buildAssertion) => {
    await expect(
      validateCloudflareAccessAssertion({
        assertion: await buildAssertion(),
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

describe("Cloudflare Access team key fetches", () => {
  // The specified refetch cooldown for an unknown key id.
  const keyRefetchCooldownMs = 30_000;
  const keySetUrl = new URL("/cdn-cgi/access/certs", issuer);
  let publishedKeys: JSONWebKeySet;
  let keyFetches: number;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    publishedKeys = { keys: [publicJwk] };
    keyFetches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(keySetUrl.href);
      keyFetches += 1;
      return Response.json(publishedKeys);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function signedWithNewKey(kid: string) {
    const keys = await teamSigningKey(kid);
    return {
      jwk: keys.jwk,
      assertion: await createAssertion(
        {},
        { header: { alg: "RS256", kid }, key: keys.privateKey },
      ),
    };
  }

  function validate(
    assertion: string,
    remoteKeySet: ReturnType<typeof createCloudflareAccessKeySet>,
  ) {
    return validateCloudflareAccessAssertion({
      assertion,
      configuration: { issuer, audience },
      keySet: remoteKeySet,
      now,
    });
  }

  /** A remote key set that fetched the team's keys once, at `now`. */
  async function loadedRemoteKeySet() {
    const remoteKeySet = createCloudflareAccessKeySet(keySetUrl);
    await validate(await createAssertion(), remoteKeySet);
    expect(keyFetches).toBe(1);
    return remoteKeySet;
  }

  it("refetches the team's keys once for a burst of unknown key ids", async () => {
    const remoteKeySet = await loadedRemoteKeySet();

    vi.setSystemTime(now.getTime() + keyRefetchCooldownMs);
    for (let index = 0; index < 20; index += 1) {
      const { assertion } = await signedWithNewKey(`bogus-${index}`);
      await expect(validate(assertion, remoteKeySet)).rejects.toBeInstanceOf(
        AccessIdentityError,
      );
    }
    expect(keyFetches).toBe(2);
  });

  it("refetches the team's keys once for simultaneous unknown key ids in a Worker", async () => {
    // jose shares one in-flight key fetch between callers, except in a
    // Worker, where one request may not wait on another request's fetch. It
    // detects a Worker by `WebSocketPair`.
    vi.stubGlobal("WebSocketPair", class {});
    const remoteKeySet = await loadedRemoteKeySet();

    vi.setSystemTime(now.getTime() + keyRefetchCooldownMs);
    const assertions = await Promise.all(
      Array.from({ length: 20 }, (_, index) => signedWithNewKey(`bogus-${index}`)),
    );
    const results = await Promise.allSettled(
      assertions.map(({ assertion }) => validate(assertion, remoteKeySet)),
    );
    for (const result of results) {
      expect(result.status).toBe("rejected");
      expect(
        result.status === "rejected" ? result.reason : undefined,
      ).toBeInstanceOf(AccessIdentityError);
    }
    expect(keyFetches).toBe(2);
  });

  it("accepts a key the team rotates in once the cooldown has passed", async () => {
    const remoteKeySet = await loadedRemoteKeySet();

    const rotated = await signedWithNewKey("key-2");
    publishedKeys = { keys: [publicJwk, rotated.jwk] };

    vi.setSystemTime(now.getTime() + keyRefetchCooldownMs - 1);
    await expect(
      validate(rotated.assertion, remoteKeySet),
    ).rejects.toBeInstanceOf(AccessIdentityError);
    expect(keyFetches).toBe(1);

    vi.setSystemTime(now.getTime() + keyRefetchCooldownMs);
    await expect(validate(rotated.assertion, remoteKeySet)).resolves.toEqual({
      binding: { issuer, subject: "access-subject" },
      email: "owner@example.com",
      nonce: "access-nonce",
    });
    expect(keyFetches).toBe(2);
  });
});
