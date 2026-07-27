import { describe, expect, it } from "vitest";

import { createContentWorkspaceId } from "@foundry/application";

import {
  PreviewCapabilityError,
  createPreviewCapability,
  verifyPreviewCapability,
} from "./preview-capability";

const identity = {
  binding: { issuer: "https://access.example", subject: "editor-subject" },
  email: "editor@example.com",
  nonce: "identity-nonce",
};
const workspaceId = createContentWorkspaceId("workspace_home");
const inputs = {
  identity,
  audience: "foundry-dashboard",
  workspaceId,
  revision: 3,
  secret: "a-preview-capability-secret",
};

describe("preview capability", () => {
  it("binds an expiring capability to actor, workspace and revision", async () => {
    const capability = await createPreviewCapability({
      ...inputs,
      now: new Date("2026-07-27T12:00:00Z"),
    });

    await expect(
      verifyPreviewCapability({
        ...inputs,
        capability,
        now: new Date("2026-07-27T12:04:59Z"),
      }),
    ).resolves.toBeUndefined();
    await expect(
      verifyPreviewCapability({
        ...inputs,
        revision: 4,
        capability,
        now: new Date("2026-07-27T12:04:59Z"),
      }),
    ).rejects.toBeInstanceOf(PreviewCapabilityError);
  });

  it("rejects an expired capability", async () => {
    const capability = await createPreviewCapability({
      ...inputs,
      now: new Date("2026-07-27T12:00:00Z"),
    });

    await expect(
      verifyPreviewCapability({
        ...inputs,
        capability,
        now: new Date("2026-07-27T12:05:01Z"),
      }),
    ).rejects.toBeInstanceOf(PreviewCapabilityError);
  });
});
