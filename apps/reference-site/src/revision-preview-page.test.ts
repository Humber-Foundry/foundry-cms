import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  getRevision: vi.fn(),
  isRevisionCurrent: vi.fn(),
  loadApplication: vi.fn(),
  loadIdentity: vi.fn(),
  verifyCapability: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    cache<T extends (...args: never[]) => unknown>(callback: T): T {
      const values = new Map<string, ReturnType<T>>();
      return ((...args: Parameters<T>) => {
        const key = JSON.stringify(args);
        if (!values.has(key)) {
          values.set(key, callback(...args) as ReturnType<T>);
        }
        return values.get(key);
      }) as T;
    },
  };
});
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  notFound() {
    throw new Error("not_found");
  },
}));
vi.mock("./human-access-runtime", () => ({
  authorizeAuthenticatedHumanIdentity: mocks.authorize,
  loadHumanIdentityRequestContext: mocks.loadIdentity,
}));
vi.mock("./content-revision-runtime", () => ({
  loadContentRevisionApplication: mocks.loadApplication,
}));
vi.mock("./preview-capability-runtime", () => ({
  verifyRevisionPreviewCapability: mocks.verifyCapability,
}));

import { loadRevisionPreview } from "./revision-preview-page";

describe("revision preview page", () => {
  it("memoizes one authenticated revision for metadata and body", async () => {
    const identity = {
      binding: { issuer: "issuer", subject: "subject" },
      email: "editor@example.com",
    };
    const revision = {
      workspaceId: "workspace_home",
      revision: 3,
      createdAt: "2026-07-27T12:00:00.000Z",
      definition: {
        home: {
          seo: {
            title: "Edited SEO title",
            description: "Edited SEO description",
          },
        },
      },
      inputs: {
        contentHash: "content-hash",
        schemaVersion: "1.1.0",
        rendererVersion: "renderer-a",
        productionBase: "production-a",
      },
    };
    mocks.loadIdentity.mockResolvedValue({ identity });
    mocks.authorize.mockResolvedValue({
      state: "authorized",
      identity,
      membership: { id: "membership-editor" },
    });
    mocks.getRevision.mockResolvedValue(revision);
    mocks.isRevisionCurrent.mockResolvedValue(true);
    mocks.loadApplication.mockResolvedValue({
      queries: {
        getRevision: mocks.getRevision,
        isRevisionCurrent: mocks.isRevisionCurrent,
      },
    });
    const props = {
      params: Promise.resolve({
        workspaceId: "workspace_home",
        revision: "3",
      }),
      searchParams: Promise.resolve({
        capability: "preview-capability",
        bookmark: "d1-bookmark",
      }),
    };

    const metadataRevision = await loadRevisionPreview(props);
    const bodyRevision = await loadRevisionPreview(props);

    expect(metadataRevision).toBe(bodyRevision);
    expect(metadataRevision.definition.home.seo).toEqual({
      title: "Edited SEO title",
      description: "Edited SEO description",
    });
    expect(mocks.loadIdentity).toHaveBeenCalledTimes(1);
    expect(mocks.authorize).toHaveBeenCalledTimes(1);
    expect(mocks.verifyCapability).toHaveBeenCalledTimes(1);
    expect(mocks.getRevision).toHaveBeenCalledTimes(1);
    expect(mocks.isRevisionCurrent).toHaveBeenCalledTimes(1);
  });
});
