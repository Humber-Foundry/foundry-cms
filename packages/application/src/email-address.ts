export class InvalidEmailAddressError extends Error {
  constructor() {
    super("invalid_email_address");
    this.name = "InvalidEmailAddressError";
  }
}

export function normalizeEmailAddress(value: unknown): string {
  if (typeof value !== "string") {
    throw new InvalidEmailAddressError();
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    throw new InvalidEmailAddressError();
  }
  return normalized;
}
