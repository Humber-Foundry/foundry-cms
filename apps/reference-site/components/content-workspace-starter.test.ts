import { describe, expect, it, vi } from "vitest";

import { createContentWorkspaceId } from "@foundry/application";

import {
  preparePreservedRevisionRecovery,
  workspaceCreationOperation,
} from "./content-workspace-starter";

const preservedRevision = {
  workspaceId: createContentWorkspaceId("workspace_legacy"),
  revision: 4,
  schemaVersion: "1.0.0",
} as const;

describe("content workspace schema recovery", () => {
  it("creates a unique workspace instead of reopening the legacy default", () => {
    expect(workspaceCreationOperation(preservedRevision)).toBe(
      "create_workspace",
    );
    expect(workspaceCreationOperation(undefined)).toBe(
      "create_default_workspace",
    );
  });

  it("forwards pending legacy outbox edits into the fresh workspace recovery", async () => {
    const setItem = vi.fn();
    await expect(
      preparePreservedRevisionRecovery({
        preservedRevision,
        readOutbox: async () => ({
          workspaceId: preservedRevision.workspaceId,
          baseRevision: preservedRevision.revision,
          edits: [
            {
              path: "site_foundry_reference.name",
              baseValue: "Foundry Reference",
              value: "Pending legacy edit",
            },
          ],
        }),
        storage: {
          getItem: () => null,
          removeItem: vi.fn(),
          setItem,
        },
        createRecoveryId: () =>
          "12345678-1234-4123-8123-123456789abc",
      }),
    ).resolves.toEqual({
      id: "12345678-1234-4123-8123-123456789abc",
      sourceWorkspaceId: "workspace_legacy",
    });
    expect(setItem).toHaveBeenCalledWith(
      "foundry-cms:stale-edit-recovery:workspace_legacy:12345678-1234-4123-8123-123456789abc",
      expect.stringContaining("Pending legacy edit"),
    );
  });

  it("does not create a recovery pointer when no pending edits exist", async () => {
    await expect(
      preparePreservedRevisionRecovery({
        preservedRevision,
        readOutbox: async () => null,
        storage: {
          getItem: () => null,
          removeItem: vi.fn(),
          setItem: vi.fn(),
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("forwards a saved legacy edit when the browser outbox is empty", async () => {
    const setItem = vi.fn();
    await expect(
      preparePreservedRevisionRecovery({
        preservedRevision,
        durableRecoveryEdits: [
          {
            path: "site_foundry_reference.name",
            baseValue: "Foundry Reference",
            value: "Saved legacy draft",
          },
        ],
        readOutbox: async () => null,
        storage: {
          getItem: () => null,
          removeItem: vi.fn(),
          setItem,
        },
        createRecoveryId: () =>
          "12345678-1234-4123-8123-123456789abc",
      }),
    ).resolves.toEqual({
      id: "12345678-1234-4123-8123-123456789abc",
      sourceWorkspaceId: "workspace_legacy",
    });
    expect(setItem).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("Saved legacy draft"),
    );
  });
});
