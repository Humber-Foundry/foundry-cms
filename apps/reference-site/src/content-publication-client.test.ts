import { describe, expect, it, vi } from "vitest";

import {
  contentPublicationPollDelay,
  loadContentPublication,
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
  it("backs active publication polling off to a bounded interval", () => {
    expect(
      [0, 1, 2, 3, 4, 20].map(contentPublicationPollDelay),
    ).toEqual([2_500, 5_000, 10_000, 20_000, 30_000, 30_000]);
  });

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

    await loadContentPublication({
      workspaceId: "workspace_publish",
      publicationId: "publish_123",
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/foundry-cms/publications?workspaceId=workspace_publish&publicationId=publish_123",
      { cache: "no-store" },
    );
  });

  it("loads the latest durable workspace publication after a dashboard reload", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ publication: { status: "deployed" } }));

    await loadContentPublication({
      workspaceId: "workspace_publish",
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/foundry-cms/publications?workspaceId=workspace_publish",
      { cache: "no-store" },
    );
  });

  it("refreshes durable status only through the protected mutation path", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        json({ publication: { status: "verified-live" } }),
      );

    await refreshContentPublication({
      workspaceId: "workspace_publish",
      publicationId: "publish_123",
      mutationToken: "mutation-token",
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/foundry-cms/publications",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-foundry-csrf": "mutation-token",
        }),
        body: JSON.stringify({
          operation: "refresh",
          workspaceId: "workspace_publish",
          publicationId: "publish_123",
        }),
      }),
    );
  });
});
