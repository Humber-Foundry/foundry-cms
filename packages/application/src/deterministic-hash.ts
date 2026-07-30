export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function sha256CanonicalJson(value: unknown): Promise<string> {
  return sha256Text(canonicalJson(value));
}

export async function sha256TextBytes(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest(
    "SHA-256",
      new TextEncoder().encode(value),
    ),
  );
}

export async function sha256Text(value: string): Promise<string> {
  return Array.from(await sha256TextBytes(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function hmacSha256CanonicalJson(
  keyValue: string,
  value: unknown,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(keyValue),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(canonicalJson(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function lengthDelimitedText(parts: ReadonlyArray<string>): string {
  const encoder = new TextEncoder();
  return parts
    .map((part) => `${encoder.encode(part).byteLength}:${part}`)
    .join("");
}
