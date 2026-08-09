import type { ExternalHumanIdentity } from "@humber-foundry/application";

export const verifiedDashboardIdentityHeader =
  "x-foundry-verified-dashboard-identity";

export function withVerifiedDashboardIdentity(
  request: Request,
  identity: ExternalHumanIdentity,
): Request {
  const headers = new Headers(request.headers);
  headers.delete(verifiedDashboardIdentityHeader);
  headers.set(
    verifiedDashboardIdentityHeader,
    encodeURIComponent(JSON.stringify(identity)),
  );
  return new Request(request, { headers });
}

export function withoutVerifiedDashboardIdentity(
  request: Request,
): Request {
  const headers = new Headers(request.headers);
  headers.delete(verifiedDashboardIdentityHeader);
  return new Request(request, { headers });
}

export function readVerifiedDashboardIdentity(
  requestHeaders: Headers,
): ExternalHumanIdentity | null {
  const encoded = requestHeaders.get(verifiedDashboardIdentityHeader);
  if (encoded === null) {
    return null;
  }
  try {
    const identity: unknown = JSON.parse(decodeURIComponent(encoded));
    if (
      typeof identity !== "object" ||
      identity === null ||
      !("binding" in identity) ||
      typeof identity.binding !== "object" ||
      identity.binding === null ||
      !("issuer" in identity.binding) ||
      typeof identity.binding.issuer !== "string" ||
      identity.binding.issuer === "" ||
      !("subject" in identity.binding) ||
      typeof identity.binding.subject !== "string" ||
      identity.binding.subject === "" ||
      !("email" in identity) ||
      typeof identity.email !== "string" ||
      identity.email === "" ||
      !("nonce" in identity) ||
      typeof identity.nonce !== "string" ||
      identity.nonce === ""
    ) {
      return null;
    }
    return Object.freeze({
      binding: Object.freeze({
        issuer: identity.binding.issuer,
        subject: identity.binding.subject,
      }),
      email: identity.email,
      nonce: identity.nonce,
    });
  } catch {
    return null;
  }
}
