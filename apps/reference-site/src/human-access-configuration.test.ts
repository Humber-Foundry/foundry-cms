import { describe, expect, it } from "vitest";

import {
  createDeferredAccessEligibilitySynchronizer,
  HumanAccessConfigurationError,
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
});
