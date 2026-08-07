import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  AccessDeniedError,
  createHumanInvitationId,
  createHumanMembershipId,
  createHumanUserId,
  createInMemoryHumanAccessStore,
  type HumanInvitation,
} from "@foundry/application";

import {
  authenticateHumanAccessRequest,
  loadHumanAccessRequestContext,
} from "./human-access-runtime";
import { AccessIdentityError } from "./access-identity";
import { HumanAccessConfigurationError } from "./human-access-configuration";
import { referenceSiteApplication } from "./reference-installation";

const configuration = {
  FOUNDRY_ACCESS_ISSUER: "https://foundry.cloudflareaccess.com",
  FOUNDRY_ACCESS_AUDIENCE: "reference-audience",
};
const identity = {
  binding: {
    issuer: configuration.FOUNDRY_ACCESS_ISSUER,
    subject: "editor-subject",
  },
  email: "editor@example.com",
  nonce: "editor-nonce",
};

/**
 * An invitation is claimable only while `expiresAt` is in the future, and the
 * runtime reads the real clock. A fixed date would therefore pass until it
 * arrived and fail every run after it, so the fixture stays ahead of now.
 */
function claimableExpiry(): string {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString();
}

describe("protected human request boundary", () => {
  it("requires the production dashboard worker verification marker", async () => {
    await expect(
      loadHumanAccessRequestContext(new Headers()),
    ).rejects.toEqual(new AccessIdentityError());
  });

  it("fails closed when production authentication is not configured", async () => {
    await expect(
      authenticateHumanAccessRequest({
        requestHeaders: new Headers(),
        runtime: "production",
        environment: {},
      }),
    ).rejects.toEqual(new HumanAccessConfigurationError());
  });

  it("returns a claimable invitation without mutating it during authentication", async () => {
    const invitation: HumanInvitation = {
      id: createHumanInvitationId("invitation-editor"),
      siteId: referenceSiteApplication.siteId,
      email: identity.email,
      role: "editor",
      status: "pending_acceptance",
      expiresAt: claimableExpiry(),
      invitedByMembershipId: createHumanMembershipId("membership-owner"),
    };
    const validateAssertion = vi.fn().mockResolvedValue(identity);
    const context = await authenticateHumanAccessRequest({
      requestHeaders: new Headers({
        "cf-access-jwt-assertion": "signed-assertion",
      }),
      runtime: "test",
      environment: configuration,
      store: createInMemoryHumanAccessStore({ invitations: [invitation] }),
      validateAssertion,
    });

    expect(context.state).toBe("invited");
    await expect(
      context.application.queries.canActivateInvitation({ actor: identity }),
    ).resolves.toBe(true);
  });

  it("rejects a validated identity without active membership or invitation", async () => {
    await expect(
      authenticateHumanAccessRequest({
        requestHeaders: new Headers({
          "cf-access-jwt-assertion": "signed-assertion",
        }),
        runtime: "test",
        environment: configuration,
        store: createInMemoryHumanAccessStore(),
        validateAssertion: vi.fn().mockResolvedValue(identity),
      }),
    ).rejects.toEqual(new AccessDeniedError("membership_not_found"));
  });

  it("lets a reinvited revoked identity reach invitation activation", async () => {
    const invitation: HumanInvitation = {
      id: createHumanInvitationId("invitation-returning-editor"),
      siteId: referenceSiteApplication.siteId,
      email: identity.email,
      role: "editor",
      status: "pending_acceptance",
      expiresAt: claimableExpiry(),
      invitedByMembershipId: createHumanMembershipId("membership-owner"),
    };
    const context = await authenticateHumanAccessRequest({
      requestHeaders: new Headers({
        "cf-access-jwt-assertion": "signed-assertion",
      }),
      runtime: "test",
      environment: configuration,
      store: createInMemoryHumanAccessStore({
        invitations: [invitation],
        memberships: [
          {
            id: createHumanMembershipId("membership-revoked-editor"),
            siteId: referenceSiteApplication.siteId,
            userId: createHumanUserId("user-revoked-editor"),
            email: identity.email,
            identityBinding: identity.binding,
            role: "editor",
            status: "revoked",
          },
        ],
      }),
      validateAssertion: vi.fn().mockResolvedValue(identity),
    });

    expect(context.state).toBe("invited");
  });
});
