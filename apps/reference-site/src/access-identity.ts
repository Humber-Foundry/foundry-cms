import {
  createLocalJWKSet,
  createRemoteJWKSet,
  errors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from "jose";

import {
  InvalidHumanEmailError,
  normalizeHumanEmail,
  type ExternalHumanIdentity,
} from "@humber-foundry/application";

const clockToleranceSeconds = 60;
const maximumKeyCacheAgeMs = 24 * 60 * 60 * 1_000;

export type CloudflareAccessConfiguration = Readonly<{
  issuer: string;
  audience: string;
}>;

export class AccessIdentityError extends Error {
  constructor() {
    super("access_identity_invalid");
    this.name = "AccessIdentityError";
  }
}

export class AccessIdentityUnavailableError extends Error {
  constructor() {
    super("access_identity_keys_unavailable");
    this.name = "AccessIdentityUnavailableError";
  }
}

function validateConfiguration({
  issuer,
  audience,
}: CloudflareAccessConfiguration): URL {
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuer);
  } catch {
    throw new AccessIdentityError();
  }

  if (
    issuerUrl.protocol !== "https:" ||
    !issuerUrl.hostname.endsWith(".cloudflareaccess.com") ||
    issuerUrl.pathname !== "/" ||
    issuerUrl.search !== "" ||
    issuerUrl.hash !== "" ||
    audience.trim() === ""
  ) {
    throw new AccessIdentityError();
  }

  return issuerUrl;
}

export function createCloudflareAccessKeySet(
  source: JSONWebKeySet | URL,
): JWTVerifyGetKey {
  if (source instanceof URL) {
    return createRemoteJWKSet(source, {
      cacheMaxAge: maximumKeyCacheAgeMs,
      cooldownDuration: 0,
      timeoutDuration: 5_000,
    });
  }

  return createLocalJWKSet(source);
}

export function createRemoteCloudflareAccessKeySet(
  configuration: CloudflareAccessConfiguration,
): JWTVerifyGetKey {
  const issuerUrl = validateConfiguration(configuration);
  return createCloudflareAccessKeySet(
    new URL("/cdn-cgi/access/certs", issuerUrl),
  );
}

function isKeyServiceFailure(error: unknown): boolean {
  return (
    error instanceof errors.JWKSTimeout ||
    (error instanceof TypeError &&
      error.message.toLowerCase().includes("fetch")) ||
    (error instanceof errors.JOSEError &&
      (error.message ===
        "Expected 200 OK from the JSON Web Key Set HTTP response" ||
        error.message ===
          "Failed to parse the JSON Web Key Set HTTP response as JSON"))
  );
}

export async function validateCloudflareAccessAssertion({
  assertion,
  configuration,
  keySet,
  now = new Date(),
}: {
  assertion: string;
  configuration: CloudflareAccessConfiguration;
  keySet: JWTVerifyGetKey;
  now?: Date;
}): Promise<ExternalHumanIdentity> {
  validateConfiguration(configuration);

  try {
    const { payload, protectedHeader } = await jwtVerify(assertion, keySet, {
      algorithms: ["RS256"],
      issuer: configuration.issuer,
      audience: configuration.audience,
      clockTolerance: clockToleranceSeconds,
      currentDate: now,
    });
    const nowSeconds = Math.floor(now.getTime() / 1_000);

    if (
      protectedHeader.alg !== "RS256" ||
      typeof protectedHeader.kid !== "string" ||
      protectedHeader.kid === "" ||
      payload.type !== "app" ||
      typeof payload.sub !== "string" ||
      payload.sub === "" ||
      typeof payload.identity_nonce !== "string" ||
      payload.identity_nonce === "" ||
      typeof payload.iat !== "number" ||
      payload.iat > nowSeconds + clockToleranceSeconds ||
      typeof payload.nbf !== "number" ||
      typeof payload.exp !== "number" ||
      payload.iat > payload.exp ||
      payload.nbf > payload.exp
    ) {
      throw new AccessIdentityError();
    }

    return Object.freeze({
      binding: {
        issuer: configuration.issuer,
        subject: payload.sub,
      },
      email: normalizeHumanEmail(payload.email),
      nonce: payload.identity_nonce,
    });
  } catch (error) {
    if (error instanceof AccessIdentityError) {
      throw error;
    }
    if (isKeyServiceFailure(error)) {
      throw new AccessIdentityUnavailableError();
    }
    if (error instanceof InvalidHumanEmailError) {
      throw new AccessIdentityError();
    }
    throw new AccessIdentityError();
  }
}
