import { describe, expect, it, vi } from "vitest";
import { sendMediaMutationAttempt } from "./media-mutation-client";

describe("media mutation client", () => {
  it("refreshes an expired token and retries the same attempt identity", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ error: "request_check_failed" }, { status: 403 }),
      )
      .mockResolvedValueOnce(
        Response.json({ mutationToken: "fresh-media-token" }),
      )
      .mockResolvedValueOnce(Response.json({ assetId: "asset_hero" }));
    const attempt = {
      body: JSON.stringify({ operation: "delete", assetId: "asset_hero" }),
      contentType: "application/json" as const,
      idempotencyKey: "stable-media-attempt-0001",
    };

    const result = await sendMediaMutationAttempt({
      attempt,
      mutationToken: "expired-media-token",
      fetcher,
    });

    expect(result.mutationToken).toBe("fresh-media-token");
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      "/api/foundry-cms/media",
      expect.objectContaining({
        body: attempt.body,
        headers: expect.objectContaining({
          "idempotency-key": attempt.idempotencyKey,
          "x-foundry-csrf": "fresh-media-token",
        }),
      }),
    );
  });
});
