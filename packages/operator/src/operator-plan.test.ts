import { describe, expect, it } from "vitest";

import {
  CredentialMaterialRefusedError,
  fingerprintPattern,
} from "./configuration-fingerprint";
import {
  OperatorPlanError,
  approvalBindingInputs,
  assertPlanStillApplies,
  createOperatorPlan,
  operatorPlanSchemaVersion,
  parseOperatorPlan,
  serializeOperatorPlan,
} from "./operator-plan";

const installationId = "01984f2a-1c00-7000-8000-0000000000aa";
const deploymentId = "01984f2a-1c00-7000-8000-0000000000bb";

const inputs = {
  githubOwner: "acme-marine",
  githubRepository: "acme-marine-site",
  productionBranch: "main",
  cloudflareAccountScopeFingerprint: `sha256:${"1".repeat(64)}`,
  githubAccountScopeFingerprint: `sha256:${"2".repeat(64)}`,
  canonicalHostname: "acme-marine.example",
  foundationReleaseVersion: "1.4.0",
  foundationReleaseDigest: `sha256:${"f".repeat(64)}`,
  dataRegion: "weur",
  repositoryVisibility: "private",
};

function plan(overrides: Record<string, unknown> = {}) {
  return createOperatorPlan({
    command: "scaffold",
    installationId,
    deploymentId,
    inputs,
    createdAt: "2026-07-27T00:00:00.000Z",
    cliVersion: "1.4.0",
    ...overrides,
  });
}

describe("operator plans", () => {
  it("binds the approval to a hash of the reviewed inputs", async () => {
    const created = await plan();

    expect(created.schemaVersion).toBe(operatorPlanSchemaVersion);
    expect(created.inputHash).toMatch(fingerprintPattern);
    expect(created.inputs).toEqual(inputs);
  });

  it("hashes the same inputs to the same value regardless of key order", async () => {
    const reordered = Object.fromEntries(
      Object.entries(inputs).reverse(),
    ) as typeof inputs;

    expect((await plan({ inputs: reordered })).inputHash).toBe(
      (await plan()).inputHash,
    );
  });

  it("changes the hash when any approval-binding input changes", async () => {
    const base = (await plan()).inputHash;

    for (const field of approvalBindingInputs) {
      const changed = await plan({
        inputs: { ...inputs, [field]: `${inputs[field]}-changed` },
      });
      expect(changed.inputHash).not.toBe(base);
    }
  });

  it("requires every approval-binding input", async () => {
    for (const field of approvalBindingInputs) {
      const partial = { ...inputs } as Record<string, unknown>;
      delete partial[field];
      await expect(plan({ inputs: partial })).rejects.toThrow(
        new RegExp(`plan_input_missing:${field}`, "u"),
      );
    }
  });

  it("refuses an undeclared input rather than silently ignoring it", async () => {
    await expect(
      plan({ inputs: { ...inputs, cloudflareAccountId: "9f1c0a2b" } }),
    ).rejects.toThrow(/plan_input_unexpected/u);
  });

  it("refuses a plan carrying credential material", async () => {
    await expect(
      plan({
        inputs: {
          ...inputs,
          githubOwner: "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
        },
      }),
    ).rejects.toThrow(CredentialMaterialRefusedError);
  });

  it("binds the command and both identities into the approval hash", async () => {
    const base = await plan();

    expect((await plan({ command: "migrate" })).inputHash).not.toBe(
      base.inputHash,
    );
    expect(
      (await plan({ installationId: "01984f2a-1c00-7000-8000-0000000000dd" }))
        .inputHash,
    ).not.toBe(base.inputHash);
    expect(
      (await plan({ deploymentId: "01984f2a-1c00-7000-8000-0000000000cc" }))
        .inputHash,
    ).not.toBe(base.inputHash);
  });

  it("refuses a committed plan whose identity was swapped after review", async () => {
    const created = await plan();
    const swapped = serializeOperatorPlan(created).replace(
      `"installationId": "${installationId}"`,
      `"installationId": "01984f2a-1c00-7000-8000-0000000000dd"`,
    );

    await expect(parseOperatorPlan(swapped)).rejects.toThrow(
      /plan_input_hash_mismatch/u,
    );
  });

  it("refuses a committed plan whose command was swapped after review", async () => {
    const created = await plan();
    const swapped = serializeOperatorPlan(created).replace(
      '"command": "scaffold"',
      '"command": "migrate"',
    );

    await expect(parseOperatorPlan(swapped)).rejects.toThrow(
      /plan_input_hash_mismatch/u,
    );
  });

  it("refuses a plan naming a command outside the v1 surface", async () => {
    await expect(plan({ command: "publish" })).rejects.toThrow(
      /plan_command_unknown/u,
    );
  });

  it("refuses an identity that is missing or self-referential", async () => {
    await expect(plan({ installationId: "not-a-uuid" })).rejects.toThrow(
      OperatorPlanError,
    );
    await expect(plan({ deploymentId: installationId })).rejects.toThrow(
      OperatorPlanError,
    );
  });
});

describe("plan serialization", () => {
  it("round-trips", async () => {
    const created = await plan();
    const parsed = await parseOperatorPlan(serializeOperatorPlan(created));

    expect(parsed).toEqual(created);
  });

  it("refuses a plan whose recorded hash no longer matches its inputs", async () => {
    const created = await plan();
    const tampered = serializeOperatorPlan(created).replace(
      "acme-marine.example",
      "attacker.example",
    );

    await expect(parseOperatorPlan(tampered)).rejects.toThrow(
      /plan_input_hash_mismatch/u,
    );
  });

  it("refuses an incompatible plan schema", async () => {
    const created = serializeOperatorPlan(await plan()).replace(
      operatorPlanSchemaVersion,
      "foundry.operator-plan/v2",
    );

    await expect(parseOperatorPlan(created)).rejects.toThrow(
      /plan_schema_incompatible/u,
    );
  });

  it("refuses unparsable or malformed input", async () => {
    await expect(parseOperatorPlan("not json")).rejects.toThrow(
      OperatorPlanError,
    );
    await expect(parseOperatorPlan("[]")).rejects.toThrow(OperatorPlanError);
    await expect(
      parseOperatorPlan(
        JSON.stringify({
          schemaVersion: operatorPlanSchemaVersion,
          inputHash: "nope",
        }),
      ),
    ).rejects.toThrow(/plan_input_hash_invalid/u);
  });
});

describe("re-checking a plan before execution", () => {
  it("passes when the observed inputs still match", async () => {
    await expect(
      assertPlanStillApplies({ plan: await plan(), observedInputs: inputs }),
    ).resolves.toBeUndefined();
  });

  it("names the account, hostname, release or region that changed", async () => {
    const created = await plan();

    await expect(
      assertPlanStillApplies({
        plan: created,
        observedInputs: {
          ...inputs,
          cloudflareAccountScopeFingerprint: `sha256:${"3".repeat(64)}`,
        },
      }),
    ).rejects.toThrow(/plan_inputs_changed:cloudflareAccountScopeFingerprint/u);

    await expect(
      assertPlanStillApplies({
        plan: created,
        observedInputs: { ...inputs, canonicalHostname: "other.example" },
      }),
    ).rejects.toThrow(/plan_inputs_changed:canonicalHostname/u);

    await expect(
      assertPlanStillApplies({
        plan: created,
        observedInputs: { ...inputs, foundationReleaseVersion: "1.5.0" },
      }),
    ).rejects.toThrow(/plan_inputs_changed:foundationReleaseVersion/u);

    await expect(
      assertPlanStillApplies({
        plan: created,
        observedInputs: { ...inputs, dataRegion: "apac" },
      }),
    ).rejects.toThrow(/plan_inputs_changed:dataRegion/u);
  });
});
