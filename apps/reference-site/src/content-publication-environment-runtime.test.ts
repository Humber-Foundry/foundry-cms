import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createContentApprovalId,
  createContentWorkspaceId,
} from "@humber-foundry/application";

const mocks = vi.hoisted(() => ({
  findApproval: vi.fn(),
  findPublicationByIdempotency: vi.fn(),
  hasScheduledPublicationOwnership: vi.fn(),
  getProductionHead: vi.fn(),
  invalidateApproval: vi.fn(),
  isReleaseLive: vi.fn(),
}));

vi.mock("./d1-blog-post-operations-store", () => ({
  confirmVerifiedArchiveWithdrawals: vi.fn(),
}));

vi.mock("./d1-content-publication-store", () => ({
  createD1ContentPublicationStore: () => ({
    findApproval: mocks.findApproval,
    findPublicationByIdempotency:
      mocks.findPublicationByIdempotency,
    hasScheduledPublicationOwnership:
      mocks.hasScheduledPublicationOwnership,
    invalidateApproval: mocks.invalidateApproval,
  }),
}));

vi.mock("./github-content-publisher", () => ({
  createGitHubContentPublisher: () => ({
    getProductionHead: mocks.getProductionHead,
    isReleaseLive: mocks.isReleaseLive,
  }),
  readGitHubContentPublisherConfiguration: () => ({}),
}));

vi.mock("server-only", () => ({}));

import {
  validateContentApprovalProductionAuthority,
} from "./content-publication-environment-runtime";

describe("content publication production authority", () => {
  const approvalId =
    createContentApprovalId(`approval_${"1".repeat(32)}`);
  const workspaceId =
    createContentWorkspaceId("workspace_owned_publication");
  const fingerprint = {
    value: "approved-fingerprint",
    productionBase:
      `git:${"a".repeat(40)}@content:${"b".repeat(64)}`,
    schemaVersion: "foundry.site-definition.v1",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasScheduledPublicationOwnership.mockResolvedValue(true);
    mocks.findApproval.mockResolvedValue({
      id: approvalId,
      workspaceId,
      fingerprint,
      invalidatedAt: "2026-11-01T08:05:00.000Z",
    });
  });

  it("recognizes an exact owned publication before checking the original production base", async () => {
    mocks.findPublicationByIdempotency.mockResolvedValue({
      id: "publication-owned",
      approvalId,
      fingerprint: fingerprint.value,
      status: "committed",
    });

    await expect(
      validateContentApprovalProductionAuthority(
        { FOUNDRY_DB: {} as never },
        approvalId,
        "scheduled-publication:schedule-owned",
      ),
    ).resolves.toBe(true);

    expect(mocks.getProductionHead).not.toHaveBeenCalled();
    expect(mocks.isReleaseLive).not.toHaveBeenCalled();
    expect(mocks.invalidateApproval).not.toHaveBeenCalled();
  });

  it("does not grant recovery authority to a publication with a different fingerprint", async () => {
    mocks.findApproval.mockResolvedValue({
      id: approvalId,
      workspaceId,
      fingerprint,
      invalidatedAt: null,
    });
    mocks.findPublicationByIdempotency.mockResolvedValue({
      id: "publication-foreign",
      approvalId,
      fingerprint: "different-fingerprint",
      status: "committed",
    });
    mocks.getProductionHead.mockResolvedValue("c".repeat(40));
    mocks.isReleaseLive.mockResolvedValue(false);

    await expect(
      validateContentApprovalProductionAuthority(
        { FOUNDRY_DB: {} as never },
        approvalId,
        "scheduled-publication:schedule-foreign",
      ),
    ).resolves.toBe(false);

    expect(mocks.invalidateApproval).toHaveBeenCalledWith({
      approvalId,
      invalidatedAt: expect.any(String),
      reason: "production_changed",
    });
  });

  it("does not grant invalidated authority to a failed publication that would require a new side effect", async () => {
    mocks.findPublicationByIdempotency.mockResolvedValue({
      id: "publication-failed",
      approvalId,
      fingerprint: fingerprint.value,
      status: "failed",
    });

    await expect(
      validateContentApprovalProductionAuthority(
        { FOUNDRY_DB: {} as never },
        approvalId,
        "scheduled-publication:schedule-failed",
      ),
    ).resolves.toBe(false);

    expect(mocks.getProductionHead).not.toHaveBeenCalled();
    expect(mocks.isReleaseLive).not.toHaveBeenCalled();
  });

  it("keeps exact failed deployment retry authority while the approval remains valid", async () => {
    mocks.findApproval.mockResolvedValue({
      id: approvalId,
      workspaceId,
      fingerprint,
      invalidatedAt: null,
    });
    mocks.findPublicationByIdempotency.mockResolvedValue({
      id: "publication-failed-deployment",
      approvalId,
      fingerprint: fingerprint.value,
      status: "failed",
    });

    await expect(
      validateContentApprovalProductionAuthority(
        { FOUNDRY_DB: {} as never },
        approvalId,
        "scheduled-publication:schedule-failed-deployment",
      ),
    ).resolves.toBe(true);

    expect(mocks.getProductionHead).not.toHaveBeenCalled();
    expect(mocks.isReleaseLive).not.toHaveBeenCalled();
  });

  it("does not adopt a matching publication without durable schedule ownership", async () => {
    mocks.findApproval.mockResolvedValue({
      id: approvalId,
      workspaceId,
      fingerprint,
      invalidatedAt: null,
    });
    mocks.findPublicationByIdempotency.mockResolvedValue({
      id: "publication-unowned",
      approvalId,
      fingerprint: fingerprint.value,
      status: "committed",
    });
    mocks.hasScheduledPublicationOwnership.mockResolvedValue(false);
    mocks.getProductionHead.mockResolvedValue("c".repeat(40));
    mocks.isReleaseLive.mockResolvedValue(false);

    await expect(
      validateContentApprovalProductionAuthority(
        { FOUNDRY_DB: {} as never },
        approvalId,
        "scheduled-publication:schedule-unowned",
      ),
    ).resolves.toBe(false);

    expect(mocks.invalidateApproval).toHaveBeenCalledWith({
      approvalId,
      invalidatedAt: expect.any(String),
      reason: "production_changed",
    });
  });
});
