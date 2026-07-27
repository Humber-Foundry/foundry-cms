import { describe, expect, it } from "vitest";

import {
  createDeferredAccessEligibilitySynchronizer,
  HumanAccessConfigurationError,
  readSubscriberIdentityKeySecret,
} from "./human-access-configuration";

describe("human access synchronization configuration", () => {
  it("defers missing Access policy settings until synchronization starts", async () => {
    const synchronizer =
      createDeferredAccessEligibilitySynchronizer({});

    await expect(
      synchronizer.replaceExactEmailEligibility([
        "owner@example.com",
      ]),
    ).rejects.toBeInstanceOf(HumanAccessConfigurationError);
  });

  it("requires a dedicated strong subscriber identity key", () => {
    expect(() => readSubscriberIdentityKeySecret({})).toThrow(
      HumanAccessConfigurationError,
    );
    expect(() =>
      readSubscriberIdentityKeySecret({
        FOUNDRY_SUBSCRIBER_IDENTITY_SECRET: "too-short",
      }),
    ).toThrow(HumanAccessConfigurationError);
    expect(
      readSubscriberIdentityKeySecret({
        FOUNDRY_SUBSCRIBER_IDENTITY_SECRET:
          "production-subscriber-identity-secret",
      }),
    ).toBe("production-subscriber-identity-secret");
  });
});
