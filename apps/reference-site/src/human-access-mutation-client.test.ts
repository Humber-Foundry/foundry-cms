import { describe, expect, it, vi } from "vitest";

import {
  createHumanAccessMutationAttempt,
  isHumanAccessMutationAmbiguousFailure,
  isHumanAccessMutationInProgress,
  isHumanAccessMutationRequestCheckFailed,
  isHumanAccessMutationRequestCheckUnavailable,
  membershipStatusConfirmation,
  sendHumanAccessMutationAttempt,
} from "./human-access-mutation-client";
import {
  humanMutationResultHeader,
  recordedHumanMutationResult,
} from "./human-mutation-protocol";

describe("human access mutation client", () => {
  it("describes destructive membership changes before dispatch", () => {
    expect(
      membershipStatusConfirmation("editor@example.com", "suspended"),
    ).toBe(
      "Suspend editor@example.com? They will lose dashboard access until an Owner activates them again.",
    );
    expect(
      membershipStatusConfirmation("editor@example.com", "revoked"),
    ).toBe(
      "Revoke editor@example.com? They will lose dashboard access permanently and must receive a new invitation to return.",
    );
    expect(
      membershipStatusConfirmation("editor@example.com", "active"),
    ).toBeNull();
  });

  it("keeps one idempotency key through two lost responses and a manual retry", async () => {
    const response = Response.json({ ok: true });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockRejectedValueOnce(new TypeError("response lost again"))
      .mockResolvedValueOnce(response);
    const attempt = createHumanAccessMutationAttempt({
      action: "change_status",
      membershipId: "membership-1",
      status: "suspended",
    });

    await expect(
      sendHumanAccessMutationAttempt(attempt, "csrf", fetcher),
    ).rejects.toThrow("response lost again");
    await expect(
      sendHumanAccessMutationAttempt(attempt, "csrf", fetcher),
    ).resolves.toBe(response);

    expect(fetcher).toHaveBeenCalledTimes(3);
    const requests = fetcher.mock.calls.map(([, request]) => request);
    expect(
      requests.map(
        (request) =>
          (request?.headers as Record<string, string>)["idempotency-key"],
      ),
    ).toEqual([
      attempt.idempotencyKey,
      attempt.idempotencyKey,
      attempt.idempotencyKey,
    ]);
    expect(requests.map((request) => request?.body)).toEqual([
      attempt.body,
      attempt.body,
      attempt.body,
    ]);
  });

  it("keeps one key from transport loss through in-progress to completed replay", async () => {
    const inProgress = Response.json(
      { error: "request_in_progress" },
      { status: 409 },
    );
    const completed = Response.json({ ok: true });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce(inProgress)
      .mockResolvedValueOnce(completed);
    const attempt = createHumanAccessMutationAttempt({
      action: "claim_invitation",
    });

    const ambiguous = await sendHumanAccessMutationAttempt(
      attempt,
      "csrf",
      fetcher,
    );
    expect(await isHumanAccessMutationInProgress(ambiguous)).toBe(true);

    const replay = await sendHumanAccessMutationAttempt(
      attempt,
      "csrf",
      fetcher,
    );
    expect(await isHumanAccessMutationInProgress(replay)).toBe(false);
    expect(replay).toBe(completed);

    expect(
      fetcher.mock.calls.map(
        ([, request]) =>
          (request?.headers as Record<string, string>)["idempotency-key"],
      ),
    ).toEqual([
      attempt.idempotencyKey,
      attempt.idempotencyKey,
      attempt.idempotencyKey,
    ]);
  });

  it("keeps one key through a stale-token refresh and uses the new CSRF token", async () => {
    const staleToken = Response.json(
      { error: "request_check_failed" },
      { status: 403 },
    );
    const completed = Response.json({ ok: true });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce(staleToken)
      .mockResolvedValueOnce(completed);
    const attempt = createHumanAccessMutationAttempt({
      action: "change_status",
      membershipId: "membership-1",
      status: "suspended",
    });

    const staleResponse = await sendHumanAccessMutationAttempt(
      attempt,
      "old-csrf",
      fetcher,
    );
    expect(staleResponse.status).toBe(403);
    expect(
      await isHumanAccessMutationRequestCheckFailed(staleResponse),
    ).toBe(true);
    await expect(
      sendHumanAccessMutationAttempt(attempt, "new-csrf", fetcher),
    ).resolves.toBe(completed);

    const requests = fetcher.mock.calls.map(([, request]) => request);
    expect(
      requests.map(
        (request) =>
          (request?.headers as Record<string, string>)["idempotency-key"],
      ),
    ).toEqual([
      attempt.idempotencyKey,
      attempt.idempotencyKey,
      attempt.idempotencyKey,
    ]);
    expect(
      requests.map(
        (request) =>
          (request?.headers as Record<string, string>)["x-foundry-csrf"],
      ),
    ).toEqual(["old-csrf", "old-csrf", "new-csrf"]);
  });

  it("treats a receipted authorization denial as conclusive", async () => {
    const denial = Response.json(
      { error: "not_authorized" },
      { status: 403 },
    );

    await expect(
      isHumanAccessMutationRequestCheckFailed(denial),
    ).resolves.toBe(false);
  });

  it("distinguishes a temporary pre-receipt check outage from a receipted outage", async () => {
    const preReceiptOutage = Response.json(
      { error: "request_check_unavailable" },
      { status: 503 },
    );
    const receiptedOutage = Response.json(
      { error: "access_unavailable" },
      { status: 503 },
    );

    await expect(
      isHumanAccessMutationRequestCheckUnavailable(preReceiptOutage),
    ).resolves.toBe(true);
    await expect(
      isHumanAccessMutationRequestCheckUnavailable(receiptedOutage),
    ).resolves.toBe(false);
  });

  it("preserves unknown server failures but releases explicit receipted failures", async () => {
    await expect(
      isHumanAccessMutationAmbiguousFailure(
        new Response("worker failed", { status: 500 }),
      ),
    ).resolves.toBe(true);
    await expect(
      isHumanAccessMutationAmbiguousFailure(
        Response.json(
          { error: "access_unavailable" },
          {
            status: 503,
            headers: {
              [humanMutationResultHeader]: recordedHumanMutationResult,
            },
          },
        ),
      ),
    ).resolves.toBe(false);
    await expect(
      isHumanAccessMutationAmbiguousFailure(
        Response.json(
          { error: "access_sync_pending", d1Committed: true },
          {
            status: 503,
            headers: {
              [humanMutationResultHeader]: recordedHumanMutationResult,
            },
          },
        ),
      ),
    ).resolves.toBe(false);
  });

  it("preserves intermediary throttling and unknown authorization responses", async () => {
    await expect(
      isHumanAccessMutationAmbiguousFailure(
        new Response("too many requests", { status: 429 }),
      ),
    ).resolves.toBe(true);
    await expect(
      isHumanAccessMutationAmbiguousFailure(
        Response.json(
          { error: "cloudflare_challenge" },
          { status: 403 },
        ),
      ),
    ).resolves.toBe(true);
    await expect(
      isHumanAccessMutationAmbiguousFailure(
        Response.json(
          { error: "not_authorized" },
          {
            status: 403,
            headers: {
              [humanMutationResultHeader]: recordedHumanMutationResult,
            },
          },
        ),
      ),
    ).resolves.toBe(false);
  });

  it("requires a recorded application marker for successful responses", async () => {
    await expect(
      isHumanAccessMutationAmbiguousFailure(
        new Response("<html>sign in</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    ).resolves.toBe(true);
    await expect(
      isHumanAccessMutationAmbiguousFailure(
        Response.json({ unexpected: true }),
      ),
    ).resolves.toBe(true);
    await expect(
      isHumanAccessMutationAmbiguousFailure(
        Response.json(
          { membership: { id: "membership-1" } },
          {
            headers: {
              [humanMutationResultHeader]: recordedHumanMutationResult,
            },
          },
        ),
      ),
    ).resolves.toBe(false);
  });
});
