import { afterEach, describe, expect, it, vi } from "vitest";

import { applyFormOperation } from "./use-form-operation";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("form operation request", () => {
  it("sends the command with the mutation token and a fresh idempotency key", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => "key-1" });

    await expect(
      applyFormOperation({ action: "release_spam" }, "token-1"),
    ).resolves.toBe("applied");
    expect(fetchMock).toHaveBeenCalledWith("/api/foundry-cms/forms", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "key-1",
        "x-foundry-csrf": "token-1",
      },
      body: '{"action":"release_spam"}',
    });
  });

  it("reports a refused command apart from an unconfirmed one", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "key-1" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    await expect(applyFormOperation({}, "token-1")).resolves.toBe("refused");

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(applyFormOperation({}, "token-1")).resolves.toBe(
      "unconfirmed",
    );
  });
});
