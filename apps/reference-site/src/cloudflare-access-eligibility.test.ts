import { describe, expect, it, vi } from "vitest";

import {
  AccessEligibilitySyncError,
  createCloudflareAccessEligibilitySynchronizer,
} from "./cloudflare-access-eligibility";

const policy = {
  success: true,
  result: {
    name: "Client dashboard access",
    decision: "allow",
    precedence: 7,
    session_duration: "30m",
    approval_groups: [
      {
        approvals_needed: 2,
        email_addresses: ["security@example.com"],
      },
    ],
    approval_required: true,
    isolation_required: true,
    mfa_config: { enabled: true },
    purpose_justification_prompt: "State the incident number",
    purpose_justification_required: true,
    include: [
      { email: { email: "editor@example.com" } },
      { email: { email: "owner@example.com" } },
    ],
    require: [{ login_method: { id: "otp-id" } }],
    exclude: [],
  },
};

describe("Cloudflare Access exact-email synchronization", () => {
  it("does not rewrite an already matching exact-email policy", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(policy),
    );
    const synchronizer = createCloudflareAccessEligibilitySynchronizer({
      accountId: "account-id",
      applicationId: "application-id",
      policyId: "policy-id",
      loginMethodId: "otp-id",
      apiToken: "test-token",
      fetcher,
    });

    await expect(
      synchronizer.replaceExactEmailEligibility([
        "owner@example.com",
        "editor@example.com",
      ]),
    ).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("GET");
  });

  it("repairs drift and reads back the complete D1-derived eligibility set", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: {
            ...policy.result,
            require: [{ device_posture: { id: "posture-id" } }],
            exclude: [{ email: { email: "editor@example.com" } }],
          },
        }),
      )
      .mockResolvedValueOnce(Response.json(policy))
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: {
            ...policy.result,
            require: [
              { device_posture: { id: "posture-id" } },
              { login_method: { id: "otp-id" } },
            ],
          },
        }),
      );
    const synchronizer = createCloudflareAccessEligibilitySynchronizer({
      accountId: "account-id",
      applicationId: "application-id",
      policyId: "policy-id",
      loginMethodId: "otp-id",
      apiToken: "test-token",
      fetcher,
    });

    await expect(
      synchronizer.replaceExactEmailEligibility([
        "owner@example.com",
        "editor@example.com",
      ]),
    ).resolves.toBeUndefined();
    const update = fetcher.mock.calls[1]?.[1];
    expect(update?.method).toBe("PUT");
    expect(JSON.parse(String(update?.body))).toMatchObject({
      name: "Client dashboard access",
      decision: "allow",
      precedence: 7,
      session_duration: "30m",
      approval_groups: [
        {
          approvals_needed: 2,
          email_addresses: ["security@example.com"],
        },
      ],
      approval_required: true,
      isolation_required: true,
      mfa_config: { enabled: true },
      purpose_justification_prompt: "State the incident number",
      purpose_justification_required: true,
      include: [
        { email: { email: "editor@example.com" } },
        { email: { email: "owner@example.com" } },
      ],
      require: [
        { device_posture: { id: "posture-id" } },
        { login_method: { id: "otp-id" } },
      ],
    });
  });

  it("fails closed when read-back weakens preserved policy settings", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: {
            ...policy.result,
            include: [{ email: { email: "owner@example.com" } }],
          },
        }),
      )
      .mockResolvedValueOnce(Response.json(policy))
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: {
            ...policy.result,
            mfa_config: { enabled: false },
          },
        }),
      );
    const synchronizer = createCloudflareAccessEligibilitySynchronizer({
      accountId: "account-id",
      applicationId: "application-id",
      policyId: "policy-id",
      loginMethodId: "otp-id",
      apiToken: "test-token",
      fetcher,
    });

    await expect(
      synchronizer.replaceExactEmailEligibility([
        "owner@example.com",
        "editor@example.com",
      ]),
    ).rejects.toBeInstanceOf(AccessEligibilitySyncError);
  });

  it("fails closed when read-back drops preserved client hardening", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: {
            ...policy.result,
            require: [{ device_posture: { id: "posture-id" } }],
          },
        }),
      )
      .mockResolvedValueOnce(Response.json(policy))
      .mockResolvedValueOnce(Response.json(policy));
    const synchronizer = createCloudflareAccessEligibilitySynchronizer({
      accountId: "account-id",
      applicationId: "application-id",
      policyId: "policy-id",
      loginMethodId: "otp-id",
      apiToken: "test-token",
      fetcher,
    });

    await expect(
      synchronizer.replaceExactEmailEligibility([
        "owner@example.com",
        "editor@example.com",
      ]),
    ).rejects.toBeInstanceOf(AccessEligibilitySyncError);
  });

  it("fails closed when read-back contains unexpected eligibility", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: {
            ...policy.result,
            include: [{ everyone: {} }],
          },
        }),
      )
      .mockResolvedValueOnce(Response.json(policy))
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: {
            ...policy.result,
            exclude: [{ everyone: {} }],
          },
        }),
      );
    const synchronizer = createCloudflareAccessEligibilitySynchronizer({
      accountId: "account-id",
      applicationId: "application-id",
      policyId: "policy-id",
      loginMethodId: "otp-id",
      apiToken: "test-token",
      fetcher,
    });

    await expect(
      synchronizer.replaceExactEmailEligibility([
        "owner@example.com",
        "editor@example.com",
      ]),
    ).rejects.toBeInstanceOf(AccessEligibilitySyncError);
  });
});
