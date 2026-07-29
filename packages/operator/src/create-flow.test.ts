import { describe, expect, it } from "vitest";

import {
  CreateFlowError,
  assertCreateFlowCatalogIsWellOrdered,
  assertPrerequisitesVerified,
  createFlowDerivablePhases,
  createFlowStates,
  createFlowStepCatalog,
  createFlowStep,
  deriveCreateFlowState,
  deriveInstallationPhase,
  installationPhases,
  selectNextCreateStep,
  type CreateFlowStepId,
} from "./create-flow";
import {
  createProvisioningStep,
  transitionStep,
  type ProvisioningStep,
} from "./provisioning-journal";

const inputHash = `sha256:${"a".repeat(64)}`;

function stepAt(stepId: CreateFlowStepId, status: string): ProvisioningStep {
  const definition = createFlowStep(stepId);
  const initial = createProvisioningStep({
    stepId,
    prerequisites: definition.prerequisites,
    inputHash,
    createdAt: "2026-07-27T00:00:00.000Z",
  });
  if (status === "not_started") {
    return initial;
  }
  const applying = transitionStep(initial, {
    status: "applying",
    at: "2026-07-27T00:01:00.000Z",
  });
  if (status === "applying") {
    return applying;
  }
  if (status === "failed_terminal") {
    return transitionStep(applying, {
      status: "failed_terminal",
      at: "2026-07-27T00:02:00.000Z",
      code: "provider.policy_denied",
    });
  }
  const applied = transitionStep(applying, {
    status: "applied_unverified",
    at: "2026-07-27T00:02:00.000Z",
  });
  if (status === "applied_unverified") {
    return applied;
  }
  if (status === "blocked") {
    return transitionStep(initial, {
      status: "blocked",
      at: "2026-07-27T00:03:00.000Z",
      code: "reconcile.foreign",
    });
  }
  if (status === "manual_action_required") {
    return transitionStep(applied, {
      status: "manual_action_required",
      at: "2026-07-27T00:03:00.000Z",
    });
  }
  return transitionStep(applied, {
    status: "verified",
    at: "2026-07-27T00:03:00.000Z",
    verifiedChecks: definition.healthCheckIds,
  });
}

function verifiedThrough(lastStepId: CreateFlowStepId): ProvisioningStep[] {
  const index = createFlowStepCatalog.findIndex(
    (definition) => definition.stepId === lastStepId,
  );
  return createFlowStepCatalog
    .slice(0, index + 1)
    .map((definition) => stepAt(definition.stepId, "verified"));
}

describe("create flow catalog", () => {
  it("declares every prerequisite before it is used and covers every state", () => {
    expect(() => assertCreateFlowCatalogIsWellOrdered()).not.toThrow();
  });

  it("gives every provider-mutating step at least one health check", () => {
    for (const definition of createFlowStepCatalog) {
      expect(definition.healthCheckIds.length).toBeGreaterThan(0);
    }
  });

  it("starts from a read-only preflight", () => {
    expect(createFlowStepCatalog[0]?.stepId).toBe("preflight");
    expect(createFlowStepCatalog[0]?.mutatesProvider).toBe(false);
    expect(createFlowStepCatalog[0]?.prerequisites).toEqual([]);
  });

  it("provisions the fixed Cloudflare resources the inventory names", () => {
    const stepIds = createFlowStepCatalog.map((definition) => definition.stepId);
    for (const stepId of [
      "cloudflare.d1",
      "cloudflare.r2",
      "cloudflare.analytics-dataset",
      "cloudflare.turnstile",
      "cloudflare.access",
      "cloudflare.route",
      "cloudflare.builds",
      "cloudflare.cron-triggers",
      "cloudflare.web-analytics",
      "providers.notifications",
    ]) {
      expect(stepIds).toContain(stepId);
    }
  });

  it("declares the phases the handoff flow reaches without deriving them", () => {
    expect([...installationPhases]).toContain("handoff_ready");
    expect([...installationPhases]).toContain("handed_off");
    expect([...installationPhases]).toContain("degraded");
    expect([...createFlowDerivablePhases]).not.toContain("handed_off");
  });

  it("creates no Cloudflare queue by default", () => {
    expect(
      createFlowStepCatalog.map((definition) => definition.stepId),
    ).not.toContain("cloudflare.queue");
  });

  it("enables the public route only after Access is verified", () => {
    expect(createFlowStep("cloudflare.route").prerequisites).toContain(
      "cloudflare.access",
    );
    expect(createFlowStep("cloudflare.access").prerequisites).toContain(
      "cloudflare.dns",
    );
  });

  it("stores the first Owner invitation only after the route is protected", () => {
    expect(createFlowStep("owner.invitation").prerequisites).toContain(
      "cloudflare.route",
    );
  });

  it("uploads secrets only after the bootstrap Worker exists", () => {
    expect(createFlowStep("cloudflare.worker.secrets").prerequisites).toEqual([
      "cloudflare.worker.bootstrap",
    ]);
  });

  it("refuses an unknown step id", () => {
    expect(() => createFlowStep("cloudflare.queue" as CreateFlowStepId)).toThrow(
      CreateFlowError,
    );
  });
});

describe("derived state and phase", () => {
  it("starts at planned and discovered", () => {
    expect(deriveCreateFlowState([])).toBe("planned");
    expect(deriveInstallationPhase([])).toBe("discovered");
  });

  it("advances one state at a time as steps verify", () => {
    expect(deriveCreateFlowState(verifiedThrough("preflight"))).toBe(
      "preflighted",
    );
    expect(deriveCreateFlowState(verifiedThrough("github.scaffold-checks"))).toBe(
      "repository_ready",
    );
    expect(deriveCreateFlowState(verifiedThrough("cloudflare.turnstile"))).toBe(
      "resources_ready",
    );
    expect(deriveCreateFlowState(verifiedThrough("github.rulesets"))).toBe(
      "runtime_bound",
    );
    expect(deriveCreateFlowState(verifiedThrough("cloudflare.access"))).toBe(
      "access_ready",
    );
    expect(deriveCreateFlowState(verifiedThrough("owner.invitation"))).toBe(
      "owner_claimable",
    );
    expect(deriveCreateFlowState(verifiedThrough("owner.activation"))).toBe(
      "owner_active",
    );
    expect(deriveCreateFlowState(verifiedThrough("deployment.promotion"))).toBe(
      "deployment_ready",
    );
    expect(
      deriveCreateFlowState(verifiedThrough("cloudflare.cron-triggers")),
    ).toBe("owner_active");
    expect(deriveCreateFlowState(verifiedThrough("verification.create"))).toBe(
      "verification_ready",
    );
  });

  it("maps every create state onto an installation phase", () => {
    expect(createFlowStates).toHaveLength(createFlowDerivablePhases.length);
    expect(installationPhases.slice(0, createFlowStates.length)).toEqual([
      ...createFlowDerivablePhases,
    ]);
    expect(deriveInstallationPhase(verifiedThrough("cloudflare.turnstile"))).toBe(
      "cloudflare_resources_ready",
    );
    expect(deriveInstallationPhase(verifiedThrough("verification.create"))).toBe(
      "verification_ready",
    );
  });

  it("does not advance when a later step verified out of order", () => {
    expect(
      deriveCreateFlowState([
        ...verifiedThrough("preflight"),
        stepAt("cloudflare.d1", "verified"),
      ]),
    ).toBe("preflighted");
  });

  it("does not treat an applied but unverified step as progress", () => {
    expect(
      deriveCreateFlowState([stepAt("preflight", "applied_unverified")]),
    ).toBe("planned");
  });
});

describe("next step selection", () => {
  it("selects preflight first", () => {
    const selection = selectNextCreateStep([]);
    expect(selection.kind).toBe("step");
    expect(
      selection.kind === "step" ? selection.definition.stepId : null,
    ).toBe("preflight");
  });

  it("selects the first step whose prerequisites are all verified", () => {
    const selection = selectNextCreateStep(verifiedThrough("github.repository"));
    expect(
      selection.kind === "step" ? selection.definition.stepId : null,
    ).toBe("github.provisioning-state-branch");
  });

  it("never selects a step whose prerequisite is unverified", () => {
    const selection = selectNextCreateStep([
      stepAt("preflight", "applied_unverified"),
    ]);
    expect(
      selection.kind === "step" ? selection.definition.stepId : null,
    ).toBe("preflight");
  });

  it("reports a blocking prerequisite instead of skipping it", () => {
    const steps = [
      ...verifiedThrough("github.scaffold-checks"),
      stepAt("cloudflare.d1", "manual_action_required"),
    ];
    const selection = selectNextCreateStep(steps);

    expect(selection).toEqual({
      kind: "blocked",
      stepId: "cloudflare.d1",
      reason: "manual_action_required",
    });
  });

  it("keeps a blocked step blocked until it is explicitly reset", () => {
    const steps = [
      ...verifiedThrough("github.scaffold-checks"),
      stepAt("cloudflare.d1", "blocked"),
    ];

    expect(selectNextCreateStep(steps)).toEqual({
      kind: "blocked",
      stepId: "cloudflare.d1",
      reason: "blocked",
    });
  });

  it("reports a terminal failure rather than retrying it", () => {
    const steps = [
      ...verifiedThrough("github.scaffold-checks"),
      stepAt("cloudflare.d1", "failed_terminal"),
    ];

    expect(selectNextCreateStep(steps)).toEqual({
      kind: "blocked",
      stepId: "cloudflare.d1",
      reason: "failed_terminal",
    });
  });

  it("is complete when every step is verified", () => {
    expect(selectNextCreateStep(verifiedThrough("verification.create"))).toEqual(
      { kind: "complete" },
    );
  });
});

describe("prerequisite assertion", () => {
  it("passes when every prerequisite is verified", () => {
    expect(() =>
      assertPrerequisitesVerified(
        "cloudflare.d1",
        verifiedThrough("github.scaffold-checks"),
      ),
    ).not.toThrow();
  });

  it("names the unverified prerequisites", () => {
    expect(() =>
      assertPrerequisitesVerified("cloudflare.worker.bootstrap", [
        stepAt("cloudflare.d1", "verified"),
        stepAt("cloudflare.r2", "verified"),
      ]),
    ).toThrow(/cloudflare\.analytics-dataset,cloudflare\.turnstile/u);
  });
});
