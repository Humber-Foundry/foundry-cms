import { describe, expect, it, vi } from "vitest";

import {
  CredentialIntakeRefusedError,
  CredentialSlotError,
  acceptCredentialThroughSlot,
  createCredentialSlot,
  credentialSlotCatalog,
  assertDeclaredCredentialSlotsSatisfied,
  markCredentialSlotRevoked,
  markCredentialSlotVerified,
  recordCredentialRotation,
  refusedIntakeSurfaces,
  safeIntakeSurfaces,
} from "./credential-slots";

const observedAt = "2026-07-27T00:10:00.000Z";

function turnstileSlot() {
  return createCredentialSlot({
    slotId: "turnstile_secret",
    provider: "cloudflare",
    ownershipPrincipal: "client-cloudflare-administrator",
    intakeSurface: "provider_creation_response",
    minimumAuthority: "one widget verification secret",
    rotationProcedure: "rotate widget secret and repeat synthetic validation",
    healthCheckId: "forms.turnstile-validation",
  });
}

describe("credential slot records", () => {
  it("starts missing and records only non-secret facts", () => {
    const slot = turnstileSlot();

    expect(slot).toEqual({
      slotId: "turnstile_secret",
      provider: "cloudflare",
      ownershipPrincipal: "client-cloudflare-administrator",
      intakeSurface: "provider_creation_response",
      minimumAuthority: "one widget verification secret",
      rotationProcedure: "rotate widget secret and repeat synthetic validation",
      healthCheckId: "forms.turnstile-validation",
      health: "missing",
      rotatedAt: null,
      verifiedAt: null,
    });
    expect(Object.isFrozen(slot)).toBe(true);
  });

  it("has no field that could hold a value, prefix or suffix", () => {
    const slot = turnstileSlot();
    for (const key of Object.keys(slot)) {
      expect(key).not.toMatch(/value|prefix|suffix|ciphertext|request/iu);
    }
  });

  it("refuses an unknown slot id", () => {
    expect(() =>
      createCredentialSlot({
        ...turnstileSlot(),
        slotId: "shadow_admin_key" as never,
      }),
    ).toThrow(CredentialSlotError);
  });

  it("requires an ownership principal, rotation procedure and health check", () => {
    for (const field of [
      "ownershipPrincipal",
      "rotationProcedure",
      "healthCheckId",
    ] as const) {
      expect(() => createCredentialSlot({ ...turnstileSlot(), [field]: "" })).toThrow(
        CredentialSlotError,
      );
    }
  });

  it("records a secretless binding as not_required rather than omitting the slot", () => {
    const slot = createCredentialSlot({
      slotId: "staff_notification_transport_secret",
      provider: "cloudflare",
      ownershipPrincipal: "client-email-administrator",
      intakeSurface: "not_required",
      minimumAuthority: "secretless Cloudflare Email binding",
      rotationProcedure: "verify binding fingerprint after any binding change",
      healthCheckId: "forms.notification-synthetic",
      bindingFingerprint: "sha256:" + "b".repeat(64),
    });

    expect(slot.health).toBe("not_required");
    expect(slot.bindingFingerprint).toBe("sha256:" + "b".repeat(64));
  });

  it("requires a verified binding fingerprint for a secretless slot", () => {
    expect(() =>
      createCredentialSlot({
        slotId: "staff_notification_transport_secret",
        provider: "cloudflare",
        ownershipPrincipal: "client-email-administrator",
        intakeSurface: "not_required",
        minimumAuthority: "secretless Cloudflare Email binding",
        rotationProcedure: "verify binding fingerprint after any binding change",
        healthCheckId: "forms.notification-synthetic",
      }),
    ).toThrow(CredentialSlotError);
  });
});

describe("intake surfaces", () => {
  it("permits only browser authorization, hidden input, provider responses and local generation", () => {
    expect([...safeIntakeSurfaces].sort()).toEqual([
      "browser_authorization",
      "generated_in_memory",
      "hidden_stdin",
      "not_required",
      "provider_creation_response",
    ]);
  });

  it("names every refused surface from the provisioning invariants", () => {
    expect([...refusedIntakeSurfaces].sort()).toEqual([
      "command_argument",
      "environment_variable",
      "journal_row",
      "log_output",
      "plan_file",
      "repository_file",
      "url_parameter",
    ]);
  });

  it("refuses to create a slot bound to an unsafe intake surface", () => {
    for (const surface of refusedIntakeSurfaces) {
      expect(() =>
        createCredentialSlot({
          ...turnstileSlot(),
          intakeSurface: surface as never,
        }),
      ).toThrow(CredentialIntakeRefusedError);
    }
  });
});

describe("accepting a credential", () => {
  it("passes the value to the uploader and returns only a health receipt", async () => {
    const upload = vi.fn(async (_secret: string) => ({
      providerReference: "worker-secret",
    }));
    const read = vi.fn(async () => "xkeysib-0a1b2c3d4e5f60718293a4b5c6d7e8f90");

    const result = await acceptCredentialThroughSlot({
      slot: createCredentialSlot({
        slotId: "brevo_api_key",
        provider: "brevo",
        ownershipPrincipal: "client-brevo-administrator",
        intakeSurface: "hidden_stdin",
        minimumAuthority: "required client account capabilities only",
        rotationProcedure: "run provider health and test-send acceptance",
        healthCheckId: "newsletter.provider-health",
      }),
      readSecret: read,
      upload,
      observedAt,
    });

    expect(upload).toHaveBeenCalledOnce();
    expect(upload.mock.calls[0]?.[0]).toBe(
      "xkeysib-0a1b2c3d4e5f60718293a4b5c6d7e8f90",
    );
    expect(result.slot.health).toBe("unverified");
    expect(JSON.stringify(result)).not.toContain("xkeysib");
  });

  it("leaves the slot missing and never retries blindly when the upload is interrupted", async () => {
    const slot = turnstileSlot();
    const result = await acceptCredentialThroughSlot({
      slot,
      readSecret: async () => "0x4AAAAAAABCDEFGhijklmnop_qrstuvwxyz012345",
      upload: async () => {
        throw new Error("network_timeout");
      },
      observedAt,
    }).catch((error: unknown) => error);

    expect(result).toBeInstanceOf(CredentialSlotError);
    expect((result as CredentialSlotError).slot?.health).toBe("unverified");
    expect((result as CredentialSlotError).code).toBe(
      "credential_upload_unverified",
    );
  });

  it("refuses a reader that returns something other than a non-empty string", async () => {
    await expect(
      acceptCredentialThroughSlot({
        slot: turnstileSlot(),
        readSecret: async () => "",
        upload: async () => ({ providerReference: "worker-secret" }),
        observedAt,
      }),
    ).rejects.toThrow(CredentialSlotError);
  });

  it("refuses intake for a slot declared secretless", async () => {
    await expect(
      acceptCredentialThroughSlot({
        slot: createCredentialSlot({
          slotId: "staff_notification_transport_secret",
          provider: "cloudflare",
          ownershipPrincipal: "client-email-administrator",
          intakeSurface: "not_required",
          minimumAuthority: "secretless Cloudflare Email binding",
          rotationProcedure: "verify binding fingerprint",
          healthCheckId: "forms.notification-synthetic",
          bindingFingerprint: "sha256:" + "b".repeat(64),
        }),
        readSecret: async () => "value",
        upload: async () => ({ providerReference: "worker-secret" }),
        observedAt,
      }),
    ).rejects.toThrow(CredentialIntakeRefusedError);
  });
});

describe("slot health transitions", () => {
  it("verifies a slot only through a functional health check", () => {
    const slot = markCredentialSlotVerified(turnstileSlot(), {
      healthCheckId: "forms.turnstile-validation",
      observedAt,
    });

    expect(slot.health).toBe("verified");
    expect(slot.verifiedAt).toBe(observedAt);
  });

  it("refuses to verify with a different health check than the slot declares", () => {
    expect(() =>
      markCredentialSlotVerified(turnstileSlot(), {
        healthCheckId: "auth.protected-routes",
        observedAt,
      }),
    ).toThrow(CredentialSlotError);
  });

  it("records rotation time and drops the slot back to unverified", () => {
    const verified = markCredentialSlotVerified(turnstileSlot(), {
      healthCheckId: "forms.turnstile-validation",
      observedAt,
    });
    const rotated = recordCredentialRotation(verified, {
      rotatedAt: "2026-07-28T00:00:00.000Z",
    });

    expect(rotated.health).toBe("unverified");
    expect(rotated.rotatedAt).toBe("2026-07-28T00:00:00.000Z");
    expect(rotated.verifiedAt).toBeNull();
  });

  it("marks a revoked slot without pretending it is absent", () => {
    const revoked = markCredentialSlotRevoked(turnstileSlot(), {
      observedAt,
    });
    expect(revoked.health).toBe("revoked");
  });
});

describe("declared slot coverage", () => {
  const declared = ["turnstile_secret", "brevo_api_key"] as const;

  function slotsFor(ids: ReadonlyArray<string>) {
    return ids.map((slotId) =>
      createCredentialSlot({
        slotId: slotId as never,
        provider: "cloudflare",
        ownershipPrincipal: "client-cloudflare-administrator",
        intakeSurface: "hidden_stdin",
        minimumAuthority: "least privilege",
        rotationProcedure: "rotate and retest",
        healthCheckId: `slot.${slotId}`,
      }),
    );
  }

  it("passes when every declared slot has a record", () => {
    expect(() =>
      assertDeclaredCredentialSlotsSatisfied({
        declaredSlotIds: declared,
        slots: slotsFor(declared),
      }),
    ).not.toThrow();
  });

  it("blocks deploy when an adapter declares a secret with no slot row", () => {
    expect(() =>
      assertDeclaredCredentialSlotsSatisfied({
        declaredSlotIds: declared,
        slots: slotsFor(["turnstile_secret"]),
      }),
    ).toThrow(CredentialSlotError);
  });

  it("blocks deploy when a slot row exists for an undeclared secret", () => {
    expect(() =>
      assertDeclaredCredentialSlotsSatisfied({
        declaredSlotIds: ["turnstile_secret"],
        slots: slotsFor(declared),
      }),
    ).toThrow(CredentialSlotError);
  });

  it("blocks deploy when a declared slot is duplicated", () => {
    expect(() =>
      assertDeclaredCredentialSlotsSatisfied({
        declaredSlotIds: declared,
        slots: [...slotsFor(declared), ...slotsFor(["brevo_api_key"])],
      }),
    ).toThrow(CredentialSlotError);
  });
});

describe("v1 credential slot catalog", () => {
  it("names every runtime slot the provisioning design requires", () => {
    expect([...credentialSlotCatalog].sort()).toEqual([
      "backup_recovery_recipient",
      "brevo_api_key",
      "brevo_webhook_verification_secret",
      "cloudflare_access_sync_token",
      "cloudflare_analytics_read_token",
      "csrf_signing_key",
      "github_publisher_private_key",
      "mcp_oauth_signing_key",
      "provisioning_receipt_signing_key",
      "staff_notification_transport_secret",
      "turnstile_secret",
    ]);
  });
});
