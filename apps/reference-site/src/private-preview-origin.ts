export const defaultPrivatePreviewOrigin = "http://localhost:3000";

export function resolvePrivatePreviewOrigin(
  configured: string | undefined,
): string {
  if (configured === undefined || configured.trim() === "") {
    return defaultPrivatePreviewOrigin;
  }
  try {
    const parsed = new URL(configured);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.origin !== configured
    ) {
      throw new Error("private_preview_origin_invalid");
    }
    return parsed.origin;
  } catch {
    throw new Error("private_preview_origin_invalid");
  }
}

export function privatePreviewHostname(
  configured: string | undefined,
): string {
  return new URL(resolvePrivatePreviewOrigin(configured)).hostname;
}
