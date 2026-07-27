import { describe, expect, it } from "vitest";

import { createSiteId } from "@foundry/site-definition";

import {
  AccessDeniedError,
  LastOwnerError,
  createHumanInvitationId,
  createHumanMembershipId,
  createHumanUserId,
  createHumanAccessApplication,
  reconcileHumanAccessEligibility,
  type ExternalHumanIdentity,
  type HumanInvitation,
  type HumanMembership,
} from "./human-access";
import { createInMemoryHumanAccessStore } from "./in-memory-human-access-store";

const siteId = createSiteId("site_reference");
const otherSiteId = createSiteId("site_other");
const now = new Date("2026-07-27T04:00:00.000Z");

const ownerIdentity: ExternalHumanIdentity = {
  binding: {
    issuer: "https://foundry.cloudflareaccess.com",
    subject: "owner-subject",
  },
  email: "owner@example.com",
  nonce: "owner-nonce",
};

const editorIdentity: ExternalHumanIdentity = {
  binding: {
    issuer: "https://foundry.cloudflareaccess.com",
    subject: "editor-subject",
  },
  email: "editor@example.com",
  nonce: "editor-nonce",
};

function activeMembership(
  overrides: Partial<HumanMembership> = {},
): HumanMembership {
  return {
    id: createHumanMembershipId("membership-owner"),
    siteId,
    userId: createHumanUserId("user-owner"),
    email: ownerIdentity.email,
    identityBinding: ownerIdentity.binding,
    role: "owner",
    status: "active",
    ...overrides,
  };
}

function createFixture(
  memberships: HumanMembership[] = [activeMembership()],
  eligibilitySynchronizer = {
    async replaceExactEmailEligibility() {},
  },
  clock = () => now,
) {
  let nextId = 0;
  const store = createInMemoryHumanAccessStore({ memberships });
  const application = createHumanAccessApplication({
    siteId,
    store,
    eligibilitySynchronizer,
    clock,
    createId: (kind) => `${kind}-${++nextId}`,
  });

  return { application, store };
}

describe("human access application", () => {
  it("lets an Owner invite and the exact Access identity activate an Editor membership", async () => {
    const { application } = createFixture();

    const invitation = await application.commands.invite({
      actor: ownerIdentity,
      email: " Editor@Example.com ",
      role: "editor",
    });

    expect(invitation).toMatchObject({
      siteId,
      email: "editor@example.com",
      role: "editor",
      status: "pending_acceptance",
    });

    const membership = await application.commands.activateInvitation({
      actor: editorIdentity,
    });

    expect(membership).toMatchObject({
      siteId,
      email: "editor@example.com",
      identityBinding: editorIdentity.binding,
      role: "editor",
      status: "active",
    });
    await expect(
      application.queries.requireCapability({
        actor: editorIdentity,
        capability: "dashboard.view",
      }),
    ).resolves.toEqual(membership);
  });

  it("rejects an invitation claim from a different verified email", async () => {
    const { application } = createFixture();
    await application.commands.invite({
      actor: ownerIdentity,
      email: "invited@example.com",
      role: "editor",
    });

    await expect(
      application.commands.activateInvitation({ actor: editorIdentity }),
    ).rejects.toEqual(
      new AccessDeniedError("invitation_not_claimable"),
    );
  });

  it("rejects an invitation for an email that already has a membership", async () => {
    const { application } = createFixture();

    await expect(
      application.commands.invite({
        actor: ownerIdentity,
        email: " OWNER@example.com ",
        role: "editor",
      }),
    ).rejects.toEqual(
      new AccessDeniedError("membership_email_ambiguous"),
    );
  });

  it("allows a revoked email to be explicitly invited as a new user", async () => {
    const { application } = createFixture([
      activeMembership(),
      activeMembership({
        id: createHumanMembershipId("membership-revoked"),
        userId: createHumanUserId("user-revoked"),
        email: editorIdentity.email,
        identityBinding: editorIdentity.binding,
        role: "editor",
        status: "revoked",
      }),
    ]);

    await application.commands.invite({
      actor: ownerIdentity,
      email: editorIdentity.email,
      role: "editor",
    });
    const replacement =
      await application.commands.activateInvitation({
        actor: editorIdentity,
      });
    expect(replacement).toMatchObject({
      email: editorIdentity.email,
      status: "active",
    });
    const editorHistory = (
      await application.queries.listMembers({ actor: ownerIdentity })
    ).filter((membership) => membership.email === editorIdentity.email);
    expect(editorHistory).toHaveLength(2);
    expect(editorHistory.map((membership) => membership.status).sort()).toEqual(
      ["active", "revoked"],
    );
  });

  it("keeps an invitation unclaimable until Access eligibility sync succeeds", async () => {
    const { application } = createFixture([activeMembership()], {
      async replaceExactEmailEligibility() {
        throw new Error("provider unavailable");
      },
    });

    await expect(
      application.commands.invite({
        actor: ownerIdentity,
        email: editorIdentity.email,
        role: "editor",
      }),
    ).rejects.toThrow("provider unavailable");
    await expect(
      application.commands.activateInvitation({ actor: editorIdentity }),
    ).rejects.toEqual(new AccessDeniedError("invitation_not_claimable"));
  });

  it("lets an Owner force an immediate retry during backoff", async () => {
    const currentTime = now;
    let providerAvailable = false;
    const eligibilitySynchronizer = {
      async replaceExactEmailEligibility() {
        if (!providerAvailable) {
          throw new Error("provider unavailable");
        }
      },
    };
    const { application } = createFixture(
      [activeMembership()],
      eligibilitySynchronizer,
      () => currentTime,
    );

    await expect(
      application.commands.invite({
        actor: ownerIdentity,
        email: editorIdentity.email,
        role: "editor",
      }),
    ).rejects.toThrow("provider unavailable");

    providerAvailable = true;
    await application.commands.reconcileEligibility({
      actor: ownerIdentity,
    });

    await expect(
      application.commands.activateInvitation({ actor: editorIdentity }),
    ).resolves.toMatchObject({ email: editorIdentity.email, status: "active" });
  });

  it("retries scheduled work only after its bounded backoff", async () => {
    let providerAvailable = false;
    const eligibilitySynchronizer = {
      async replaceExactEmailEligibility() {
        if (!providerAvailable) {
          throw new Error("provider unavailable");
        }
      },
    };
    const { application, store } = createFixture(
      [activeMembership()],
      eligibilitySynchronizer,
    );
    await expect(
      application.commands.invite({
        actor: ownerIdentity,
        email: editorIdentity.email,
        role: "editor",
      }),
    ).rejects.toThrow("provider unavailable");

    providerAvailable = true;
    await reconcileHumanAccessEligibility({
      siteId,
      store,
      eligibilitySynchronizer,
      now: now.toISOString(),
      mode: "scheduled",
    });
    await expect(
      application.commands.activateInvitation({ actor: editorIdentity }),
    ).rejects.toEqual(new AccessDeniedError("invitation_not_claimable"));

    const afterBackoff = new Date(now.getTime() + 6_000).toISOString();
    await reconcileHumanAccessEligibility({
      siteId,
      store,
      eligibilitySynchronizer,
      now: afterBackoff,
      mode: "scheduled",
    });
    await expect(
      application.commands.activateInvitation({ actor: editorIdentity }),
    ).resolves.toMatchObject({ email: editorIdentity.email, status: "active" });
  });

  it("checks Access eligibility for drift when scheduled work is empty", async () => {
    const store = createInMemoryHumanAccessStore({
      memberships: [activeMembership()],
    });
    let synchronizationCount = 0;

    await reconcileHumanAccessEligibility({
      siteId,
      store,
      eligibilitySynchronizer: {
        async replaceExactEmailEligibility() {
          synchronizationCount += 1;
        },
      },
      now: now.toISOString(),
      mode: "scheduled",
    });

    expect(synchronizationCount).toBe(1);
  });

  it("does not acknowledge work created during policy synchronization", async () => {
    const store = createInMemoryHumanAccessStore({
      memberships: [activeMembership()],
    });
    const concurrentIdentity: ExternalHumanIdentity = {
      binding: {
        issuer: ownerIdentity.binding.issuer,
        subject: "concurrent-subject",
      },
      email: "concurrent@example.com",
      nonce: "concurrent-nonce",
    };
    const concurrentInvitation: HumanInvitation = {
      id: createHumanInvitationId("invitation-concurrent"),
      siteId,
      email: concurrentIdentity.email,
      role: "editor",
      status: "pending_access_sync",
      expiresAt: "2026-08-03T04:00:00.000Z",
      invitedByMembershipId: createHumanMembershipId("membership-owner"),
    };
    let insertedConcurrentWork = false;
    const synchronizedEmailSets: string[][] = [];
    const application = createHumanAccessApplication({
      siteId,
      store,
      clock: () => now,
      createId: (kind) => `${kind}-primary`,
      eligibilitySynchronizer: {
        async replaceExactEmailEligibility(emails) {
          synchronizedEmailSets.push([...emails]);
          if (!insertedConcurrentWork) {
            insertedConcurrentWork = true;
            await store.saveInvitationIfEmailAvailable(
              concurrentInvitation,
            );
          }
        },
      },
    });

    await application.commands.invite({
      actor: ownerIdentity,
      email: editorIdentity.email,
      role: "editor",
    });
    await expect(
      application.commands.activateInvitation({ actor: editorIdentity }),
    ).resolves.toMatchObject({ email: editorIdentity.email });
    await expect(
      application.commands.activateInvitation({
        actor: concurrentIdentity,
      }),
    ).rejects.toEqual(new AccessDeniedError("invitation_not_claimable"));
    expect(synchronizedEmailSets).toEqual([
      [editorIdentity.email, ownerIdentity.email],
      [
        concurrentIdentity.email,
        editorIdentity.email,
        ownerIdentity.email,
      ],
    ]);
  });

  it("allows only Owners to manage human access", async () => {
    const { application } = createFixture([
      activeMembership(),
      activeMembership({
        id: createHumanMembershipId("membership-editor"),
        userId: createHumanUserId("user-editor"),
        email: editorIdentity.email,
        identityBinding: editorIdentity.binding,
        role: "editor",
      }),
    ]);

    await expect(
      application.commands.invite({
        actor: editorIdentity,
        email: "new@example.com",
        role: "editor",
      }),
    ).rejects.toEqual(new AccessDeniedError("capability_not_authorized"));
  });

  it("applies suspension and revocation on the next protected operation", async () => {
    const editor = activeMembership({
      id: createHumanMembershipId("membership-editor"),
      userId: createHumanUserId("user-editor"),
      email: editorIdentity.email,
      identityBinding: editorIdentity.binding,
      role: "editor",
    });
    const { application } = createFixture([activeMembership(), editor]);

    await expect(
      application.queries.requireCapability({
        actor: editorIdentity,
        capability: "content.write",
      }),
    ).resolves.toEqual(editor);

    await application.commands.changeStatus({
      actor: ownerIdentity,
      membershipId: editor.id,
      status: "suspended",
    });

    await expect(
      application.queries.requireCapability({
        actor: editorIdentity,
        capability: "dashboard.view",
      }),
    ).rejects.toEqual(new AccessDeniedError("membership_not_active"));

    await application.commands.changeStatus({
      actor: ownerIdentity,
      membershipId: editor.id,
      status: "active",
    });

    await expect(
      application.queries.requireCapability({
        actor: editorIdentity,
        capability: "dashboard.view",
      }),
    ).resolves.toMatchObject({ status: "active", role: "editor" });

    await application.commands.changeStatus({
      actor: ownerIdentity,
      membershipId: editor.id,
      status: "revoked",
    });

    await expect(
      application.queries.requireCapability({
        actor: editorIdentity,
        capability: "dashboard.view",
      }),
    ).rejects.toEqual(new AccessDeniedError("membership_not_active"));

    await expect(
      application.commands.changeStatus({
        actor: ownerIdentity,
        membershipId: editor.id,
        status: "suspended",
      }),
    ).rejects.toEqual(
      new AccessDeniedError("membership_transition_not_allowed"),
    );
  });

  it("keeps a suspension committed when Access synchronization fails", async () => {
    const editor = activeMembership({
      id: createHumanMembershipId("membership-editor"),
      userId: createHumanUserId("user-editor"),
      email: editorIdentity.email,
      identityBinding: editorIdentity.binding,
      role: "editor",
    });
    const { application } = createFixture(
      [activeMembership(), editor],
      {
        async replaceExactEmailEligibility() {
          throw new Error("sync unavailable");
        },
      },
    );

    await expect(
      application.commands.changeStatus({
        actor: ownerIdentity,
        membershipId: editor.id,
        status: "suspended",
      }),
    ).rejects.toThrow("sync unavailable");
    await expect(
      application.queries.requireCapability({
        actor: editorIdentity,
        capability: "dashboard.view",
      }),
    ).rejects.toEqual(new AccessDeniedError("membership_not_active"));
  });

  it("fails closed for direct role-sensitive capability checks", async () => {
    const { application } = createFixture([
      activeMembership(),
      activeMembership({
        id: createHumanMembershipId("membership-editor"),
        userId: createHumanUserId("user-editor"),
        email: editorIdentity.email,
        identityBinding: editorIdentity.binding,
        role: "editor",
      }),
    ]);

    await expect(
      application.queries.requireCapability({
        actor: editorIdentity,
        capability: "access.manage",
      }),
    ).rejects.toEqual(new AccessDeniedError("capability_not_authorized"));
    await expect(
      application.queries.requireCapability({
        actor: ownerIdentity,
        capability: "access.manage",
      }),
    ).resolves.toMatchObject({ role: "owner", status: "active" });
  });

  it("does not authorize an email match with a different issuer and subject", async () => {
    const { application } = createFixture();

    await expect(
      application.queries.requireCapability({
        actor: {
          binding: {
            issuer: ownerIdentity.binding.issuer,
            subject: "replacement-subject",
          },
          email: ownerIdentity.email,
          nonce: "replacement-nonce",
        },
        capability: "dashboard.view",
      }),
    ).rejects.toEqual(new AccessDeniedError("membership_not_found"));
  });

  it("keeps memberships scoped to one installation", async () => {
    const { application } = createFixture([
      activeMembership({ siteId: otherSiteId }),
    ]);

    await expect(
      application.queries.requireCapability({
        actor: ownerIdentity,
        capability: "dashboard.view",
      }),
    ).rejects.toEqual(new AccessDeniedError("membership_not_found"));
  });

  it("keeps pending eligibility work scoped to its installation", async () => {
    const firstInvitation: HumanInvitation = {
      id: createHumanInvitationId("invitation-first-site"),
      siteId,
      email: "first@example.com",
      role: "editor",
      status: "pending_access_sync",
      expiresAt: "2026-08-03T04:00:00.000Z",
      invitedByMembershipId: createHumanMembershipId("membership-owner"),
    };
    const secondInvitation: HumanInvitation = {
      ...firstInvitation,
      id: createHumanInvitationId("invitation-second-site"),
      siteId: otherSiteId,
      email: "second@example.com",
    };
    const store = createInMemoryHumanAccessStore();
    await store.saveInvitationIfEmailAvailable(firstInvitation);
    await store.saveInvitationIfEmailAvailable(secondInvitation);

    const firstWork = await store.listPendingEligibilitySync({
      siteId,
      now: now.toISOString(),
      dueOnly: false,
    });
    const secondWork = await store.listPendingEligibilitySync({
      siteId: otherSiteId,
      now: now.toISOString(),
      dueOnly: false,
    });
    expect(firstWork).toHaveLength(1);
    expect(secondWork).toHaveLength(1);
    expect(firstWork).not.toEqual(secondWork);

    await store.markEligibilitySynchronized({
      siteId,
      operationIds: [...firstWork, ...secondWork],
      now: now.toISOString(),
    });
    await expect(
      store.listPendingEligibilitySync({
        siteId: otherSiteId,
        now: now.toISOString(),
        dueOnly: false,
      }),
    ).resolves.toEqual(secondWork);
  });

  it("preserves at least one active Owner", async () => {
    const { application } = createFixture();

    await expect(
      application.commands.changeStatus({
        actor: ownerIdentity,
        membershipId: createHumanMembershipId("membership-owner"),
        status: "suspended",
      }),
    ).rejects.toEqual(new LastOwnerError());
  });
});
