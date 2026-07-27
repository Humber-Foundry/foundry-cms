import { describe, expect, it, vi } from "vitest";

import { createCloudflareTurnstileVerifier } from "./cloudflare-turnstile";

describe("Cloudflare Turnstile verifier", () => {
  it("verifies a token server-side with a stable verification identity", async () => {
    const fetchImplementation = vi.fn(async () =>
      Response.json({
        success: true,
        hostname: "foundry.example",
        action: "contact",
      }),
    );
    const verifier = createCloudflareTurnstileVerifier({
      secret: "private-turnstile-secret",
      fetchImplementation,
    });

    await expect(
      verifier.verify({
        token: "browser-token",
        idempotencyKey: "00000000-0000-4000-8000-000000000046",
      }),
    ).resolves.toEqual({
      success: true,
      hostname: "foundry.example",
      action: "contact",
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          secret: "private-turnstile-secret",
          response: "browser-token",
          idempotency_key: "00000000-0000-4000-8000-000000000046",
        }),
      }),
    );
  });

  it("treats HTTP and malformed provider responses as unavailable", async () => {
    const verifier = createCloudflareTurnstileVerifier({
      secret: "private-turnstile-secret",
      fetchImplementation: vi.fn(async () =>
        new Response("upstream unavailable", { status: 503 }),
      ),
    });

    await expect(
      verifier.verify({
        token: "browser-token",
        idempotencyKey: "00000000-0000-4000-8000-000000000046",
      }),
    ).rejects.toThrow("turnstile_unavailable");
  });
});
