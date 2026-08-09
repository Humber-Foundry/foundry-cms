import type { PublicFormTurnstile } from "@humber-foundry/application";

type FetchImplementation = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

type SiteverifyResult = {
  success: boolean;
  hostname?: string;
  action?: string;
};

function isSiteverifyResult(value: unknown): value is SiteverifyResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "success" in value &&
    typeof value.success === "boolean" &&
    (!("hostname" in value) || typeof value.hostname === "string") &&
    (!("action" in value) || typeof value.action === "string")
  );
}

export function createCloudflareTurnstileVerifier({
  secret,
  fetchImplementation = fetch,
}: {
  secret: string;
  fetchImplementation?: FetchImplementation;
}): PublicFormTurnstile {
  return {
    async verify({ token, idempotencyKey }) {
      const response = await fetchImplementation(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            secret,
            response: token,
            idempotency_key: idempotencyKey,
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) {
        throw new Error("turnstile_unavailable");
      }
      let result: unknown;
      try {
        result = await response.json();
      } catch {
        throw new Error("turnstile_unavailable");
      }
      if (!isSiteverifyResult(result)) {
        throw new Error("turnstile_unavailable");
      }
      return result;
    },
  };
}
