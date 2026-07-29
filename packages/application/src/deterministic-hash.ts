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
