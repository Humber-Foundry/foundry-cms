import { describe, expect, it, vi } from "vitest";

import { createContentWorkspaceId } from "@humber-foundry/application";
import {
  createRichTextDocumentFromPlainText,
  referenceSiteDefinition,
  serializeRichTextDocument,
} from "@humber-foundry/site-definition";

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

  it("fails closed when an older outbox overlaps a newer saved revision", async () => {
    await expect(
      preparePreservedRevisionRecovery({
        preservedRevision: { ...preservedRevision, revision: 5 },
        durableRecoveryEdits: [
          {
            path: "site_foundry_reference.name",
            baseValue: "Foundry Reference",
            value: "Newer saved draft",
          },
        ],
        readOutbox: async () => ({
          workspaceId: preservedRevision.workspaceId,
          baseRevision: 4,
          edits: [
            {
              path: "site_foundry_reference.name",
              baseValue: "Older saved draft",
              value: "Older browser edit",
            },
          ],
        }),
        storage: {
          getItem: () => null,
          removeItem: vi.fn(),
          setItem: vi.fn(),
        },
      }),
    ).rejects.toThrow("content_editor_recovery_revision_conflict");
  });

  it("rebases each edit when a reconciled outbox reports the latest revision", async () => {
    await expect(
      preparePreservedRevisionRecovery({
        preservedRevision: { ...preservedRevision, revision: 5 },
        durableRecoveryEdits: [
          {
            path: "site_foundry_reference.name",
            baseValue: "Foundry Reference",
            value: "Newer saved draft",
          },
        ],
        readOutbox: async () => ({
          workspaceId: preservedRevision.workspaceId,
          baseRevision: 5,
          edits: [
            {
              path: "site_foundry_reference.name",
              baseValue: "Older saved draft",
              value: "Older tab edit",
            },
          ],
        }),
        storage: {
          getItem: () => null,
          removeItem: vi.fn(),
          setItem: vi.fn(),
        },
      }),
    ).rejects.toThrow("content_editor_recovery_revision_conflict");
  });

  it("rebases a legacy plain rich-text outbox over its saved rich-text edit", async () => {
    const baseValue = serializeRichTextDocument(
      createRichTextDocumentFromPlainText("Published body"),
    );
    const durableValue = serializeRichTextDocument(
      createRichTextDocumentFromPlainText("Saved legacy body"),
    );
    const expectedValue = serializeRichTextDocument(
      createRichTextDocumentFromPlainText(
        "Unsaved legacy browser body",
      ),
    );
    const setItem = vi.fn();

    await expect(
      preparePreservedRevisionRecovery({
        preservedRevision: { ...preservedRevision, revision: 5 },
        durableRecoveryEdits: [
          {
            path: "section_contact.body",
            format: "richText",
            baseValue,
            value: durableValue,
          },
        ],
        readOutbox: async () => ({
          workspaceId: preservedRevision.workspaceId,
          baseRevision: 5,
          edits: [
            {
              path: "section_contact.body",
              baseValue: "Saved legacy body",
              value: "Unsaved legacy browser body",
            },
          ],
        }),
        storage: {
          getItem: () => null,
          removeItem: vi.fn(),
          setItem,
        },
        createRecoveryId: () =>
          "abcdefab-cdef-4abc-8def-abcdefabcdef",
      }),
    ).resolves.toEqual({
      id: "abcdefab-cdef-4abc-8def-abcdefabcdef",
      sourceWorkspaceId: "workspace_legacy",
    });
    expect(JSON.parse(setItem.mock.calls[0]![1]).edits).toEqual([
      {
        path: "section_contact.body",
        format: "richText",
        baseValue,
        value: expectedValue,
      },
    ]);
  });

  it("normalizes legacy structural ancestry before rebasing it", async () => {
    const legacyProof = {
      id: "section_saved_proof",
      type: "proof",
      quote: "Saved proof",
      attribution: "Saved author",
      metrics: [],
    };
    const currentProof = { ...legacyProof, variant: "panel" };
    const composition = (components: ReadonlyArray<unknown>) =>
      JSON.stringify({ slotId: "slot_home_sections", components });
    const setItem = vi.fn();
    await expect(
      preparePreservedRevisionRecovery({
        preservedRevision: { ...preservedRevision, revision: 5 },
        durableRecoveryEdits: [
          {
            path: "slot_home_sections",
            baseValue: composition([]),
            value: composition([currentProof]),
          },
        ],
        readOutbox: async () => ({
          workspaceId: preservedRevision.workspaceId,
          baseRevision: 5,
          edits: [
            {
              path: "slot_home_sections",
              baseValue: composition([legacyProof]),
              value: composition([
                { ...legacyProof, quote: "Unsaved proof" },
              ]),
            },
          ],
        }),
        storage: {
          getItem: () => null,
          removeItem: vi.fn(),
          setItem,
        },
        createRecoveryId: () =>
          "abcdefab-cdef-4abc-8def-abcdefabcdef",
      }),
    ).resolves.toEqual({
      id: "abcdefab-cdef-4abc-8def-abcdefabcdef",
      sourceWorkspaceId: "workspace_legacy",
    });
    expect(setItem).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('\\"variant\\":\\"panel\\"'),
    );
  });

  it("compares structural ancestry independent of property order", async () => {
    const durableProof = {
      variant: "panel",
      type: "proof",
      id: "section_saved_proof",
      metrics: [],
      attribution: "Saved author",
      quote: "Saved proof",
    };
    const legacyProof = {
      id: "section_saved_proof",
      type: "proof",
      quote: "Saved proof",
      attribution: "Saved author",
      metrics: [],
    };
    const composition = (components: ReadonlyArray<unknown>) =>
      JSON.stringify({ slotId: "slot_home_sections", components });
    const setItem = vi.fn();
    await expect(
      preparePreservedRevisionRecovery({
        preservedRevision: { ...preservedRevision, revision: 5 },
        durableRecoveryEdits: [
          {
            path: "slot_home_sections",
            baseValue: composition([]),
            value: composition([durableProof]),
          },
        ],
        readOutbox: async () => ({
          workspaceId: preservedRevision.workspaceId,
          baseRevision: 5,
          edits: [
            {
              path: "slot_home_sections",
              baseValue: composition([legacyProof]),
              value: composition([
                { ...legacyProof, quote: "Unsaved proof" },
              ]),
            },
          ],
        }),
        storage: {
          getItem: () => null,
          removeItem: vi.fn(),
          setItem,
        },
        createRecoveryId: () =>
          "abcdefab-cdef-4abc-8def-abcdefabcdef",
      }),
    ).resolves.toEqual({
      id: "abcdefab-cdef-4abc-8def-abcdefabcdef",
      sourceWorkspaceId: "workspace_legacy",
    });
    expect(setItem).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("Unsaved proof"),
    );
  });

  it("accepts identity-only structural ancestry without dropping the full value", async () => {
    const savedProof = {
      id: "section_saved_proof",
      type: "proof",
      variant: "panel",
      quote: "Saved proof",
      attribution: "Saved author",
      metrics: [],
    };
    const composition = (components: ReadonlyArray<unknown>) =>
      JSON.stringify({ slotId: "slot_home_sections", components });
    const setItem = vi.fn();
    await expect(
      preparePreservedRevisionRecovery({
        preservedRevision: { ...preservedRevision, revision: 5 },
        durableRecoveryEdits: [
          {
            path: "slot_home_sections",
            baseValue: composition([]),
            value: composition([savedProof]),
          },
        ],
        readOutbox: async () => ({
          workspaceId: preservedRevision.workspaceId,
          baseRevision: 5,
          edits: [
            {
              path: "slot_home_sections",
              baseValue: composition([
                { id: savedProof.id, type: savedProof.type },
              ]),
              value: composition([
                { ...savedProof, quote: "Unsaved identity recovery" },
              ]),
            },
          ],
        }),
        storage: {
          getItem: () => null,
          removeItem: vi.fn(),
          setItem,
        },
        createRecoveryId: () =>
          "abcdefab-cdef-4abc-8def-abcdefabcdef",
      }),
    ).resolves.toEqual({
      id: "abcdefab-cdef-4abc-8def-abcdefabcdef",
      sourceWorkspaceId: "workspace_legacy",
    });
    expect(setItem).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("Unsaved identity recovery"),
    );
  });

  it("copies an active recovery record through another schema transition", async () => {
    const recoveryId = "12345678-1234-4123-8123-123456789abc";
    const sourceWorkspaceId = "workspace_original";
    const setItem = vi.fn();
    await expect(
      preparePreservedRevisionRecovery({
        preservedRevision,
        activeRecovery: { id: recoveryId, sourceWorkspaceId },
        readOutbox: async () => null,
        storage: {
          getItem: (key) =>
            key.includes(sourceWorkspaceId)
              ? JSON.stringify({
                  sourceWorkspaceId,
                  edits: [
                    {
                      path: "section_hero.title",
                      baseValue: "Published title",
                      value: "Recovered title",
                    },
                  ],
                })
              : null,
          removeItem: vi.fn(),
          setItem,
        },
        createRecoveryId: () =>
          "abcdefab-cdef-4abc-8def-abcdefabcdef",
      }),
    ).resolves.toEqual({
      id: "abcdefab-cdef-4abc-8def-abcdefabcdef",
      sourceWorkspaceId: "workspace_legacy",
    });
    expect(setItem).toHaveBeenCalledWith(
      expect.stringContaining("workspace_legacy"),
      expect.stringContaining("Recovered title"),
    );
  });

  it("preserves rich-text format through an otherwise unchanged recovery hop", async () => {
    const recoveryId = "12345678-1234-4123-8123-123456789abc";
    const sourceWorkspaceId = "workspace_original";
    const callToAction = referenceSiteDefinition.home.sections.find(
      (section) => section.type === "callToAction",
    )!;
    if (callToAction.type !== "callToAction") {
      throw new Error("expected_call_to_action_fixture");
    }
    const richEdit = {
      path: `${callToAction.id}.body`,
      format: "richText" as const,
      baseValue: serializeRichTextDocument(callToAction.body),
      value: serializeRichTextDocument({
        ...callToAction.body,
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "text",
                text: "Recovered through two schema transitions",
                marks: ["italic"],
              },
            ],
          },
        ],
      }),
    };
    const setItem = vi.fn();

    await preparePreservedRevisionRecovery({
      preservedRevision,
      activeRecovery: { id: recoveryId, sourceWorkspaceId },
      readOutbox: async () => null,
      storage: {
        getItem: (key) =>
          key.includes(sourceWorkspaceId)
            ? JSON.stringify({
                sourceWorkspaceId,
                edits: [richEdit],
              })
            : null,
        removeItem: vi.fn(),
        setItem,
      },
      createRecoveryId: () =>
        "abcdefab-cdef-4abc-8def-abcdefabcdef",
    });

    expect(JSON.parse(setItem.mock.calls[0]![1]).edits).toEqual([
      richEdit,
    ]);
  });
});
