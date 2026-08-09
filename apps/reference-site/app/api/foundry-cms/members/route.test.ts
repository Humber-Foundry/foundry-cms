import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AccessDeniedError,
  InvalidHumanEmailError,
  LastOwnerError,
} from "@humber-foundry/application";
import { AccessIdentityError } from "../../../../src/access-identity";
import { HumanAccessConfigurationError } from "../../../../src/human-access-configuration";
import { HumanRequestIntegrityError } from "../../../../src/human-request-integrity";
import {
  humanMutationResultHeader,
  recordedHumanMutationResult,
} from "../../../../src/human-mutation-protocol";

vi.mock("server-only", () => ({}));
const commandMocks = vi.hoisted(() => ({
  activateInvitation: vi.fn(),
  changeStatus: vi.fn(),
  invite: vi.fn(),
  reconcileEligibility: vi.fn(),
  authorizeIdentity: vi.fn(),
  loadIdentity: vi.fn(),
  verifyMutation: vi.fn(),
  receipts: new Map<
    string,
    { body: string; status: number; headers: Headers }
  >(),
}));
vi.mock("../../../../src/human-access-runtime", () => ({
  loadHumanIdentityRequestContext: commandMocks.loadIdentity,
  authorizeAuthenticatedHumanIdentity: commandMocks.authorizeIdentity,
}));
const authorizedContext = {
  identity: {
    binding: {
      issuer: "https://foundry.cloudflareaccess.com",
      subject: "owner-subject",
    },
    email: "owner@example.com",
    nonce: "owner-nonce",
  },
  membership: { role: "owner", status: "active" },
  application: { commands: commandMocks },
};
const authenticatedIdentityContext = {
  identity: authorizedContext.identity,
  authorize: commandMocks.authorizeIdentity,
};
vi.mock("../../../../src/human-mutation-runtime", () => ({
  executeIdempotentHumanMutation: async ({
    request,
    execute,
  }: {
    request: Request;
    execute: () => Promise<Response>;
  }) => {
    const key = request.headers.get("idempotency-key") ?? "test-key";
    const existing = commandMocks.receipts.get(key);
    if (existing !== undefined) {
      return new Response(existing.body, {
        status: existing.status,
        headers: existing.headers,
      });
    }
    const response = await execute();
    const body = await response.text();
    commandMocks.receipts.set(key, {
      body,
      status: response.status,
      headers: response.headers,
    });
    return new Response(body, {
      status: response.status,
      headers: response.headers,
    });
  },
  HumanMutationExecutionNotStartedError: class extends Error {
    override readonly cause: unknown;

    constructor(cause: unknown) {
      super("human_mutation_execution_not_started");
      this.cause = cause;
    }
  },
  HumanMutationIdempotencyError: class extends Error {},
  verifyHumanMutation: commandMocks.verifyMutation,
}));

import { POST } from "./route";

describe("human access command endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commandMocks.receipts.clear();
    commandMocks.authorizeIdentity.mockResolvedValue(authorizedContext);
    commandMocks.loadIdentity.mockResolvedValue(authenticatedIdentityContext);
    commandMocks.verifyMutation.mockResolvedValue(undefined);
  });

  it("distinguishes a pre-receipt identity check failure", async () => {
    commandMocks.loadIdentity.mockRejectedValueOnce(
      new AccessIdentityError(),
    );

    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "reconcile_access" }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "request_check_failed",
    });
  });

  it("distinguishes a pre-receipt configuration outage", async () => {
    commandMocks.loadIdentity.mockRejectedValueOnce(
      new HumanAccessConfigurationError(),
    );

    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "reconcile_access" }),
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "request_check_unavailable",
    });
  });

  it("distinguishes a pre-command request check failure", async () => {
    commandMocks.verifyMutation.mockRejectedValueOnce(
      new HumanRequestIntegrityError(),
    );

    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "reconcile_access" }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "request_check_failed",
    });
    expect(commandMocks.authorizeIdentity).not.toHaveBeenCalled();
  });

  it("marks a response only after the mutation receipt path completes", async () => {
    commandMocks.reconcileEligibility.mockResolvedValueOnce(undefined);

    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "reconcile_access" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get(humanMutationResultHeader)).toBe(
      recordedHumanMutationResult,
    );
  });

  it("rejects an unknown membership status instead of treating it as revocation", async () => {
    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "change_status",
          membershipId: "membership-editor",
          status: "unknown",
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_command",
    });
  });

  it("returns a conflict when a change would remove the final Owner", async () => {
    commandMocks.changeStatus.mockRejectedValueOnce(
      new LastOwnerError(),
    );

    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "change_status",
          membershipId: "membership-owner",
          status: "suspended",
        }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "last_owner",
    });
  });

  it("returns a bad request for an invalid invitation email", async () => {
    commandMocks.invite.mockRejectedValueOnce(
      new InvalidHumanEmailError(),
    );

    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "invite",
          email: "not-an-email",
          role: "editor",
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_command",
    });
  });

  it("reports deferred sync configuration failure as a committed D1 change", async () => {
    commandMocks.invite.mockRejectedValueOnce(
      new HumanAccessConfigurationError(),
    );

    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "invite",
          email: "editor@example.com",
          role: "editor",
        }),
      }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get(humanMutationResultHeader)).toBe(
      recordedHumanMutationResult,
    );
    await expect(response.json()).resolves.toEqual({
      error: "access_sync_pending",
      d1Committed: true,
    });
  });

  it("replays self-suspension after current authorization is gone", async () => {
    commandMocks.changeStatus.mockResolvedValueOnce({
      id: "membership-owner",
      status: "suspended",
    });
    const createRequest = () =>
      new Request("https://foundry.example/api/foundry-cms/members", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "self-suspension-key",
        },
        body: JSON.stringify({
          action: "change_status",
          membershipId: "membership-owner",
          status: "suspended",
        }),
      });

    const first = await POST(createRequest());
    commandMocks.authorizeIdentity.mockRejectedValue(
      new AccessDeniedError("membership_not_active"),
    );
    const replay = await POST(createRequest());

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual({
      membership: {
        id: "membership-owner",
        status: "suspended",
      },
    });
    expect(commandMocks.authorizeIdentity).toHaveBeenCalledTimes(1);
    expect(commandMocks.changeStatus).toHaveBeenCalledTimes(1);
  });

  it("replays a completed response while execution configuration is unavailable", async () => {
    commandMocks.invite.mockResolvedValueOnce({
      id: "invitation-editor",
      email: "editor@example.com",
      status: "pending_acceptance",
    });
    const createRequest = () =>
      new Request("https://foundry.example/api/foundry-cms/members", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "configuration-outage-key",
        },
        body: JSON.stringify({
          action: "invite",
          email: "editor@example.com",
          role: "editor",
        }),
      });

    const first = await POST(createRequest());
    commandMocks.authorizeIdentity.mockRejectedValue(
      new HumanAccessConfigurationError(),
    );
    const replay = await POST(createRequest());

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(commandMocks.authorizeIdentity).toHaveBeenCalledTimes(1);
    expect(commandMocks.invite).toHaveBeenCalledTimes(1);
  });
});
