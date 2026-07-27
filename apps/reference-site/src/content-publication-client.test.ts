import { describe, expect, it, vi } from "vitest";

import {
  refreshContentPublication,
  sendContentPublicationAttempt,
} from "./content-publication-client";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("content publication client", () => {
  it("retries the exact mutation once with a refreshed human token", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ error: "request_check_failed" }, 403))
      .mockResolvedValueOnce(json({ mutationToken: "fresh-token" }))
      .mockResolvedValueOnce(json({ approval: { id: "approval" } }, 201));
    const attempt = {
      body: JSON.stringify({ operation: "approve" }),
      idempotencyKey: "approve-client-0001",
    };

    await expect(
      sendContentPublicationAttempt({
        attempt,
        mutationToken: "stale-token",
        fetcher,
      }),
    ).resolves.toEqual({
      response: expect.objectContaining({ status: 201 }),
      body: { approval: { id: "approval" } },
      mutationToken: "fresh-token",
    });
    expect(fetcher.mock.calls[0]![1]).toEqual(
      expect.objectContaining({
        body: attempt.body,
        headers: expect.objectContaining({
          "idempotency-key": attempt.idempotencyKey,
          "x-foundry-csrf": "stale-token",
        }),
      }),
    );
    expect(fetcher.mock.calls[2]![1]).toEqual(
      expect.objectContaining({
        body: attempt.body,
        headers: expect.objectContaining({
          "idempotency-key": attempt.idempotencyKey,
          "x-foundry-csrf": "fresh-token",
        }),
      }),
    );
  });

  it("refreshes one explicit publication without cache", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ publication: { status: "building" } }));

    await refreshContentPublication({
      workspaceId: "workspace_publish",
      publicationId: "publish_123",
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/foundry-cms/publications?workspaceId=workspace_publish&publicationId=publish_123",
      { cache: "no-store" },
    );
  });
});
