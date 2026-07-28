import { describe, expect, it, vi } from "vitest";

import {
  contentPublicationCanRetry,
  contentPublicationPollDelay,
  loadContentPublication,
  loadContentPublicationHistory,
  refreshContentPublication,
  restoreContentPublication,
  sendContentPublicationAttempt,
} from "./content-publication-client";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("content publication client", () => {
  it.each([
    ["recorded commit", "c".repeat(40), null],
    [
      "retained candidate",
      null,
      `git_reference_not_advanced:${"c".repeat(40)}`,
    ],
    [
      "ambiguous retained candidate",
      null,
      `git_reference_result_unknown:${"c".repeat(40)}`,
    ],
  ])("offers an exact deployment retry for a %s", (_label, commitSha, detail) => {
    expect(
      contentPublicationCanRetry({
        status: "failed",
        commitSha,
        detail,
      }),
    ).toBe(true);
  });

  it("does not offer a retry without exact commit evidence", () => {
    expect(
      contentPublicationCanRetry({
        status: "failed",
        commitSha: null,
        detail: "deployment_retry_timeout",
      }),
    ).toBe(false);
  });

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

  it("loads published history without a workspace-scoped query", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ history: [] }));

    await expect(
      loadContentPublicationHistory({ fetcher }),
    ).resolves.toEqual({ history: [] });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/foundry-cms/publications?view=history",
      { cache: "no-store" },
    );
  });

  it("rejects incomplete publication history evidence", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        json({ history: [{ publication: { status: "verified-live" } }] }),
      );

    await expect(
      loadContentPublicationHistory({ fetcher }),
    ).rejects.toThrow("content_publication_history_invalid");
  });

  it("restores a published version through the protected mutation path", async () => {
    const publicationId = `publish_${"2".repeat(32)}`;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        json(
          {
            draft: {
              workspaceId: "workspace_restored",
              revision: 0,
              sourcePublicationId: publicationId,
            },
          },
          201,
        ),
      );

    await restoreContentPublication({
      publicationId,
      mutationToken: "mutation-token",
      idempotencyKey: "restore-client-history-1",
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/foundry-cms/publications",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "idempotency-key": "restore-client-history-1",
          "x-foundry-csrf": "mutation-token",
        }),
        body: JSON.stringify({
          operation: "restore",
          sourcePublicationId: publicationId,
        }),
      }),
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
