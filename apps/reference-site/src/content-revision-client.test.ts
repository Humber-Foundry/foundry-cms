import { describe, expect, it, vi } from "vitest";

import { sendContentRevisionAttempt } from "./content-revision-client";

describe("content revision client", () => {
  it("refreshes an expired mutation token and retries the same attempt", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { error: "request_check_failed" },
          { status: 403 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ mutationToken: "fresh-token" }),
      )
      .mockResolvedValueOnce(
        Response.json({ revision: 3 }, { status: 201 }),
      );
    const attempt = {
      body: '{"baseRevision":2}',
      idempotencyKey: "content-save-client-0001",
    };

    const result = await sendContentRevisionAttempt({
      attempt,
      mutationToken: "expired-token",
      fetcher,
    });

    expect(result.response.status).toBe(201);
    expect(result.mutationToken).toBe("fresh-token");
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      "/api/foundry-cms/revisions",
      expect.objectContaining({
        body: attempt.body,
        headers: expect.objectContaining({
          "idempotency-key": attempt.idempotencyKey,
          "x-foundry-csrf": "fresh-token",
        }),
      }),
    );
  });
});
