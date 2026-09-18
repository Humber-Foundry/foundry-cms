import { describe, expect, it, vi } from "vitest";

import {
  sendContentRevisionAttempt,
  sendHumanMutationAttempt,
} from "./content-revision-client";

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

  it("sends a non-revisions route's mutation but still refreshes the token from revisions", async () => {
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
        Response.json({ schedule: { id: "schedule-1" } }, { status: 201 }),
      );
    const attempt = {
      body: '{"operation":"activate_schedule"}',
      idempotencyKey: "activate-blog-post-schedule-0001",
    };

    const result = await sendHumanMutationAttempt({
      url: "/api/foundry-cms/blog-operations",
      attempt,
      mutationToken: "expired-token",
      fetcher,
    });

    expect(result.response.status).toBe(201);
    expect(result.mutationToken).toBe("fresh-token");
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "/api/foundry-cms/blog-operations",
      expect.objectContaining({ body: attempt.body }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "/api/foundry-cms/revisions",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      "/api/foundry-cms/blog-operations",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-foundry-csrf": "fresh-token" }),
      }),
    );
  });
});
