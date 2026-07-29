/**
 * Credential-shape detection shared by the configuration fingerprint guard and
 * the operator output redactor.
 *
 * The provisioning invariants forbid a secret value from becoming durable state
 * or crossing stdout. Detection is deliberately conservative in the unsafe
 * direction: a value that merely looks like credential material is treated as
 * credential material. Deterministic digests, opaque provider IDs and UUIDs
 * stay usable because they are recognised explicitly.
 */

const hexDigestPattern = /^(?:sha256:)?[0-9a-f]{32,128}$/u;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const iso8601Pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

const privateKeyBlockPattern = /-----BEGIN [A-Z ]*PRIVATE KEY-----/u;

const jsonWebTokenPattern =
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u;

const bearerCredentialPattern =
  /\b(?:bearer|basic)\s+[A-Za-z0-9+/_=-]{16,}/iu;

const secretManagerReferencePattern = new RegExp(
  `${["op", "://"].join("")}[^\\s"']+`,
  "u",
);

const userinfoUrlPattern = /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/iu;

const credentialQueryParameterPattern =
  /[?&#](?:[a-z0-9_-]*(?:token|secret|password|passwd|signature|api[_-]?key|access[_-]?key|credential)[a-z0-9_-]*)=[^&\s]+/iu;

const providerCredentialPrefixes: ReadonlyArray<RegExp> = Object.freeze([
  /\bgh[pousr]_[A-Za-z0-9]{16,}/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/u,
  /\bxkeysib-[A-Za-z0-9]{16,}/u,
  /\bxsmtpsib-[A-Za-z0-9]{16,}/u,
  /\b0x[A-Za-z0-9_-]{20,}/u,
  /\bsk-[A-Za-z0-9]{16,}/u,
  /\bCFPAT-[A-Za-z0-9_-]{16,}/u,
  /-----BEGIN [A-Z ]*(?:PRIVATE KEY|OPENSSH PRIVATE KEY)-----/u,
]);

const highEntropyCandidatePattern = /^[A-Za-z0-9+/_=-]{32,}$/u;

/**
 * Words that make a whole field name unsafe wherever they appear, because no
 * qualifier turns them back into non-secret data.
 */
const alwaysSecretWords: ReadonlySet<string> = new Set([
  "secret",
  "secrets",
  "password",
  "passwd",
  "passphrase",
]);

/**
 * Words that make a field name unsafe when they are the noun the name ends on.
 * `credentialSlotId` and `publicKeyFingerprint` name a record about a
 * credential; `brevoApiKey` and `accessToken` name the value itself.
 *
 * `signature` is deliberately absent: a signature is published evidence, and
 * provisioning receipts carry one in the client repository by design. The
 * secret behind a signature is always named for what it is — a signing key or
 * a verification secret — and those are caught here and by `alwaysSecretWords`.
 */
const secretHeadWords: ReadonlySet<string> = new Set([
  "auth",
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "key",
  "keys",
  "token",
  "tokens",
]);

/**
 * Qualifiers that make a trailing `key` public material rather than a secret.
 * A verification or public key is meant to be published — anchoring one in the
 * client repository is how a fresh operator verifies the receipt chain.
 */
const publicKeyQualifiers: ReadonlySet<string> = new Set([
  "public",
  "verification",
  "verifying",
]);

function fieldNameWords(name: string): ReadonlyArray<string> {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length > 0);
}

/**
 * Field names whose values are never safe to emit or persist, regardless of
 * the value's own shape. An empty or placeholder value under one of these names
 * is still refused so that "" can never stand in for "no secret was set".
 */
export function isCredentialFieldName(name: unknown): boolean {
  if (typeof name !== "string" || name.length === 0) {
    return false;
  }
  const words = fieldNameWords(name);
  if (words.length === 0) {
    return false;
  }
  if (words.some((word) => alwaysSecretWords.has(word))) {
    return true;
  }
  const head = words[words.length - 1] ?? "";
  if (
    (head === "key" || head === "keys") &&
    publicKeyQualifiers.has(words[words.length - 2] ?? "")
  ) {
    return false;
  }
  return secretHeadWords.has(head);
}

function isRecognisedNonSecretToken(value: string): boolean {
  return (
    hexDigestPattern.test(value) ||
    uuidPattern.test(value) ||
    iso8601Pattern.test(value)
  );
}

function hasHighEntropy(value: string): boolean {
  if (!highEntropyCandidatePattern.test(value)) {
    return false;
  }
  if (isRecognisedNonSecretToken(value)) {
    return false;
  }
  // Deterministic operator identifiers — resource stems, slugs, hex digests and
  // dotted step IDs — are lowercase. Requiring mixed case and digits keeps them
  // out of this heuristic while still catching provider API tokens and base64
  // key material, which the field-name and allowlist rules also cover.
  const distinct = new Set(value).size;
  const hasLower = /[a-z]/u.test(value);
  const hasUpper = /[A-Z]/u.test(value);
  const hasDigit = /[0-9]/u.test(value);
  return distinct >= 20 && hasLower && hasUpper && hasDigit;
}

export function looksLikeCredentialMaterial(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (
    privateKeyBlockPattern.test(trimmed) ||
    jsonWebTokenPattern.test(trimmed) ||
    bearerCredentialPattern.test(trimmed) ||
    secretManagerReferencePattern.test(trimmed) ||
    userinfoUrlPattern.test(trimmed) ||
    credentialQueryParameterPattern.test(trimmed)
  ) {
    return true;
  }
  if (providerCredentialPrefixes.some((pattern) => pattern.test(trimmed))) {
    return true;
  }
  return hasHighEntropy(trimmed);
}

export type CredentialMaterialLocation = Readonly<{
  path: string;
  reason: "field_name" | "value_shape";
}>;

/**
 * Walks an arbitrary structure and reports every place credential material
 * could be carried. Returns an empty array when the structure is safe.
 */
export function findCredentialMaterial(
  value: unknown,
  path = "$",
  seen = new Set<object>(),
): ReadonlyArray<CredentialMaterialLocation> {
  if (typeof value === "string") {
    return looksLikeCredentialMaterial(value)
      ? [Object.freeze({ path, reason: "value_shape" as const })]
      : [];
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  if (seen.has(value)) {
    return [];
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      findCredentialMaterial(entry, `${path}[${index}]`, seen),
    );
  }

  return Object.entries(value).flatMap(([key, entry]) => {
    const entryPath = `${path}.${key}`;
    if (isCredentialFieldName(key)) {
      return [Object.freeze({ path: entryPath, reason: "field_name" as const })];
    }
    return findCredentialMaterial(entry, entryPath, seen);
  });
}

export function containsCredentialMaterial(value: unknown): boolean {
  return findCredentialMaterial(value).length > 0;
}
