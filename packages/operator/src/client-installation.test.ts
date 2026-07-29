import { describe, expect, it, vi } from "vitest";

import {
  acceptCredentialThroughSlot,
  assertDeclaredCredentialSlotsSatisfied,
  computeAccountScopeFingerprint,
  createBootstrapManifest,
  createCredentialSlot,
  createInMemoryProvisioningJournal,
  createInstallationIdentity,
  createOperatorPlan,
  createProvisioningStep,
  createEd25519ReceiptSigner,
  createInMemoryProvisioningStateStore,
  createReceiptChainIntentLog,
  markCredentialSlotVerified,
  operatorExitCodes,
  createOperatorOutput,
  parseOperatorCommandLine,
  reconcileResource,
  resourceNameFor,
  runCreateFlow,
  serializeOperatorPlan,
  parseOperatorPlan,
  assertPlanStillApplies,
  transitionStep,
  verifyEd25519Receipt,
  verifyCreatedInstallation,
  type CreateFlowStepDefinition,
  type ProbeResponse,
  type ProvisioningStep,
  type StepExecution,
} from "./index";

const installationId = "01984f2a-1c00-7000-8000-0000000000aa";
const deploymentId = "01984f2a-1c00-7000-8000-0000000000bb";
const operationId = "01984f2a-1c00-7000-8000-000000000001";
const canonicalHostname = "acme-marine.example";
const commitSha = "c6be19d3f0a1b2c3d4e5f60718293a4b5c6d7e8f";
const contentHash = "a".repeat(64);
const brevoApiKey = "xkeysib-0a1b2c3d4e5f60718293a4b5c6d7e8f90";

let clock = Date.parse("2026-07-27T00:00:00.000Z");

function now(): string {
  clock += 1_000;
  return new Date(clock).toISOString();
}

async function identity() {
  return createInstallationIdentity({
    installationId,
    deploymentId,
    label: "Acme Marine",
  });
}

async function planFileContents() {
  const cloudflareScope = await computeAccountScopeFingerprint({
    provider: "cloudflare",
    accountId: "9f1c0a2b3d4e5f60718293a4b5c6d7e8",
    installationId,
    deploymentId,
  });
  const githubScope = await computeAccountScopeFingerprint({
    provider: "github",
    accountId: "acme-marine",
    installationId,
    deploymentId,
  });

  return serializeOperatorPlan(
    await createOperatorPlan({
      command: "deploy",
      installationId,
      deploymentId,
      inputs: {
        githubOwner: "acme-marine",
        githubRepository: "acme-marine-site",
        productionBranch: "main",
        cloudflareAccountScopeFingerprint: cloudflareScope,
        githubAccountScopeFingerprint: githubScope,
        canonicalHostname,
        foundationReleaseVersion: "1.4.0",
        foundationReleaseDigest: `sha256:${"f".repeat(64)}`,
        dataRegion: "weur",
        repositoryVisibility: "private",
      },
      createdAt: "2026-07-27T00:00:00.000Z",
      cliVersion: "1.4.0",
    }),
  );
}

function probeResponse(overrides: Partial<ProbeResponse> = {}): ProbeResponse {
  return { status: 200, headers: {}, body: "", ...overrides };
}

function createProbe(overrides: Record<string, ProbeResponse> = {}) {
  return async (url: string, init: { method: string }) => {
    const parsed = new URL(url);
    const key = `${init.method} ${parsed.host}${parsed.pathname}`;
    if (overrides[key] !== undefined) {
      return overrides[key];
    }
    if (parsed.host !== canonicalHostname) {
      return probeResponse({ status: 404 });
    }
    if (parsed.pathname === "/.well-known/foundry-release.json") {
      return probeResponse({
        body: JSON.stringify({ commitSha, contentHash }),
      });
    }
    if (parsed.pathname === "/") {
      return probeResponse({ body: "<html>Acme Marine</html>" });
    }
    if (
      ["/dash", "/api/foundry-cms", "/__foundry/preview"].some((family) =>
        parsed.pathname.startsWith(family),
      )
    ) {
      return probeResponse({
        status: 302,
        headers: {
          location: "https://acme.cloudflareaccess.com/cdn-cgi/access/login",
        },
      });
    }
    return probeResponse({ status: 404 });
  };
}

/**
 * Marks a step verified without touching a provider. Steps that this test does
 * not exercise in detail still have to travel the whole documented path:
 * applying, applied_unverified, then verified with real check evidence.
 */
function verifiedThrough(
  definition: CreateFlowStepDefinition,
  step: ProvisioningStep,
): ProvisioningStep {
  // A resumed step is already `applied_unverified`: its write may have landed,
  // so it reconciles and verifies rather than applying again.
  const applied =
    step.status === "applied_unverified"
      ? step
      : transitionStep(
          transitionStep(step, { status: "applying", at: now() }),
          { status: "applied_unverified", at: now() },
        );
  return transitionStep(applied, {
    status: "verified",
    at: now(),
    verifiedChecks: definition.healthCheckIds,
  });
}

function d1Candidate(overrides: Record<string, unknown> = {}) {
  return {
    providerResourceId: "8f0b1c2d-3e4f-5061-7283-94a5b6c7d8e9",
    displayName: "acme-marine-",
    installationMarker: installationId,
    deploymentMarker: deploymentId,
    configuration: {},
    createdAt: "2026-07-27T00:05:00.000Z",
    createRequestId: null,
    ...overrides,
  };
}

describe("scaffolding and deploying one client-owned installation", () => {
  async function createHarness({
    failDashProtection = false,
    pauseOnPublisherApp = false,
    leakOnAccessStep = false,
    underVerifyAccessStep = false,
  }: {
    failDashProtection?: boolean;
    pauseOnPublisherApp?: boolean;
    leakOnAccessStep?: boolean;
    underVerifyAccessStep?: boolean;
  } = {}) {
    clock = Date.parse("2026-07-27T00:00:00.000Z");

    const bound = await identity();
    const plan = await parseOperatorPlan(await planFileContents());
    const journal = createInMemoryProvisioningJournal();
    const stdout: string[] = [];
    const stderr: string[] = [];
    // Each invocation of `deploy` is one operation with one event stream; a
    // resumed run opens a new stream over the same durable journal.
    const newOutput = () =>
      createOperatorOutput({
        command: "deploy",
        json: true,
        writeOut: (line) => stdout.push(line),
        writeDiagnostic: (line) => stderr.push(line),
        operationId,
      });
    let output = newOutput();

    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const signer = await createEd25519ReceiptSigner(
      pair.privateKey,
      pair.publicKey,
    );
    const provisioningState = createInMemoryProvisioningStateStore();
    const intentLog = createReceiptChainIntentLog({
      store: provisioningState,
      signer,
      verify: verifyEd25519Receipt,
      trustAnchorPublicKey: signer.publicKey,
      installationId,
      deploymentId,
      operationId,
      now,
    });
    let nonceCounter = 0;

    const d1Name = resourceNameFor(bound, "d1");
    const d1Configuration = {
      kind: "d1",
      name: d1Name,
      location: "weur",
      readReplication: "disabled",
    };
    const created: Record<string, unknown>[] = [];
    const d1Operations = {
      findByProviderResourceId: async () => null,
      findByName: async () => [] as ReadonlyArray<never>,
      create: async ({ configuration }: { configuration: unknown }) => {
        created.push(configuration as Record<string, unknown>);
        return d1Candidate({
          displayName: d1Name,
          configuration,
        });
      },
      patch: async () => d1Candidate({ displayName: d1Name }),
      readBack: async () =>
        d1Candidate({ displayName: d1Name, configuration: d1Configuration }),
      healthCheck: async () => ({
        passed: true,
        checkIds: ["d1.schema-ledger", "d1.transaction-canary"],
      }),
      writeInstallationMarker: async () =>
        d1Candidate({ displayName: d1Name, configuration: d1Configuration }),
    };

    const uploadedSecrets: string[] = [];
    let brevoSlot = createCredentialSlot({
      slotId: "brevo_api_key",
      provider: "brevo",
      ownershipPrincipal: "client-brevo-administrator",
      intakeSurface: "hidden_stdin",
      minimumAuthority: "required client account capabilities only",
      rotationProcedure: "run provider health and test-send acceptance",
      healthCheckId: "newsletter.provider-health",
    });

    let publisherAppAuthorized = !pauseOnPublisherApp;

    const executeStep = vi.fn(
      async (
        definition: CreateFlowStepDefinition,
        step: ProvisioningStep,
      ): Promise<StepExecution> => {
        if (definition.stepId === "cloudflare.d1") {
          const result = await reconcileResource({
            identity: bound,
            step,
            target: {
              provider: "cloudflare",
              resourceKind: "d1",
              resourceName: d1Name,
            },
            desiredConfiguration: d1Configuration,
            repairableFields: ["readReplication"],
            operations: d1Operations,
            operationId,
            accountScopeFingerprint:
              plan.inputs.cloudflareAccountScopeFingerprint,
            recordedProviderResourceId: null,
            ownershipPrincipal: "client-cloudflare-account",
            createIntentProtocol: {
              log: intentLog,
              generateNonce: () => {
                nonceCounter += 1;
                return nonceCounter.toString(16).padStart(32, "0");
              },
            },
            now,
          });
          return { kind: "verified", step: result.step, resource: result.resource };
        }

        if (definition.stepId === "github.publisher-app") {
          if (!publisherAppAuthorized) {
            publisherAppAuthorized = true;
            return {
              kind: "action_required",
              step: transitionStep(
                transitionStep(step, { status: "applying", at: now() }),
                { status: "applied_unverified", at: now() },
              ),
              action: {
                kind: "browser_authorization",
                url: "https://github.com/settings/apps/new",
                expiresAt: "2026-07-27T01:00:00.000Z",
              },
            };
          }
        }

        if (underVerifyAccessStep && definition.stepId === "cloudflare.access") {
          // Claims verified while proving only one of the step's two checks.
          return {
            kind: "verified",
            step: verifiedThrough(
              { ...definition, healthCheckIds: ["access.policy-readback"] },
              step,
            ),
          };
        }

        if (leakOnAccessStep && definition.stepId === "cloudflare.access") {
          // A step whose stable error code carries credential material, which
          // the redactor must refuse to print.
          return {
            kind: "verified",
            step: transitionStep(
              transitionStep(
                transitionStep(step, { status: "applying", at: now() }),
                {
                  status: "applied_unverified",
                  at: now(),
                  code: "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
                },
              ),
              {
                status: "verified",
                at: now(),
                verifiedChecks: definition.healthCheckIds,
              },
            ),
          };
        }

        if (definition.stepId === "providers.newsletter") {
          const receipt = await acceptCredentialThroughSlot({
            slot: brevoSlot,
            readSecret: async () => brevoApiKey,
            upload: async (secret) => {
              uploadedSecrets.push(secret);
              return { providerReference: "worker-secret:brevo_api_key" };
            },
            observedAt: now(),
          });
          brevoSlot = markCredentialSlotVerified(receipt.slot, {
            healthCheckId: "newsletter.provider-health",
            observedAt: now(),
          });
        }

        return { kind: "verified", step: verifiedThrough(definition, step) };
      },
    );

    const run = () => {
      output = newOutput();
      return runCreateFlow({
        identity: bound,
        journal,
        output,
        cliVersion: "1.4.0",
        planFile: "plan.json",
        planInputHash: plan.inputHash,
        executeStep,
        now,
        verify: async () =>
          verifyCreatedInstallation({
            canonicalHostname,
            expectedCommitSha: commitSha,
            expectedContentHash: contentHash,
            bypassOrigins: ["acme.workers.dev"],
            probe: createProbe(
              failDashProtection
                ? {
                    [`GET ${canonicalHostname}/dash`]: probeResponse({
                      status: 200,
                    }),
                  }
                : {},
            ),
            publication: {
              commitSha,
              forcePushed: false,
              committer: {
                name: "acme-foundry-publisher[bot]",
                email:
                  "1234567+acme-foundry-publisher[bot]@users.noreply.github.com",
              },
              publisherAppSlug: "acme-foundry-publisher",
              approvedByRole: "owner",
              approvedByIsHuman: true,
              authoredByAgent: null,
              build: { commitSha, status: "success" },
              releaseMarker: { commitSha, contentHash },
              revision: { revisionId: "rev-1", contentHash },
            },
            configuration: {
              workerBindings: [{ name: "DB", target: d1Name }],
              dnsTargets: [canonicalHostname],
              webhookUrls: [`https://${canonicalHostname}/api/providers/brevo`],
              schedulerEndpoints: [`https://${canonicalHostname}/__scheduled`],
              accessIssuer: "https://acme.cloudflareaccess.com",
              buildTokenOwnerPrincipal: "client-build-token-owner",
              credentialSlots: [brevoSlot],
            },
            maintainerIdentifiers: ["humberfoundry.com", "humber-foundry"],
            observedAt: now(),
          }),
      });
    };

    return {
      bound,
      plan,
      journal,
      stdout,
      stderr,
      run,
      created,
      uploadedSecrets,
      provisioningState,
      get output() {
        return output;
      },
      get brevoSlot() {
        return brevoSlot;
      },
    };
  }

  it("runs the whole create flow and reaches a verified installation", async () => {
    const harness = await createHarness();
    const result = await harness.run();

    expect(result.status).toBe("verified");
    expect(result.exitCode).toBe(operatorExitCodes.verified);
    expect(result.state).toBe("verification_ready");
    expect(result.phase).toBe("verification_ready");
    expect(result.report?.status).toBe("passed");
    expect(
      result.report?.checks.map((entry) => entry.checkId),
    ).toEqual([
      "site.public-reference",
      "auth.dash-protected",
      "publication.attributed-live",
      "independence.no-maintainer-authority",
    ]);
  });

  it("opens with the command envelope and closes with one terminal result", async () => {
    const harness = await createHarness();
    const result = await harness.run();
    const events = harness.stdout.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );

    expect(events[0]).toMatchObject({
      event: "command.started",
      command: "deploy",
      operationId,
      installationId,
      deploymentId,
      deploymentRole: "target",
      inputHash: harness.plan.inputHash,
      cliVersion: "1.4.0",
    });
    expect(events[events.length - 1]).toMatchObject({
      event: "command.completed",
      command: "deploy",
      status: "verified",
    });
    expect(
      events.filter((event) => event.event === "command.completed"),
    ).toHaveLength(1);
    expect(events[events.length - 1]).not.toHaveProperty("next");
    expect(result.exitCode).toBe(operatorExitCodes.verified);
  });

  it("refuses a journal holding steps approved under another plan", async () => {
    const harness = await createHarness({ pauseOnPublisherApp: true });
    await harness.run();

    const underAnotherPlan = await runCreateFlow({
      identity: harness.bound,
      journal: harness.journal,
      output: createOperatorOutput({
        command: "deploy",
        json: true,
        writeOut: (line) => harness.stdout.push(line),
        writeDiagnostic: () => undefined,
        operationId,
      }),
      cliVersion: "1.4.0",
      planFile: "plan.json",
      planInputHash: `sha256:${"7".repeat(64)}`,
      executeStep: async () => {
        throw new Error("no step may run under a mixed journal");
      },
      verify: async () => {
        throw new Error("verification must not run under a mixed journal");
      },
      now,
    });

    expect(underAnotherPlan.status).toBe("review_required");
    expect(underAnotherPlan.exitCode).toBe(operatorExitCodes.reviewRequired);
    expect(harness.stdout.join("\n")).toContain(
      "plan.journal_bound_to_another_plan",
    );
  });

  it("offers a safe resumable next command when it stops short", async () => {
    const harness = await createHarness({ pauseOnPublisherApp: true });
    await harness.run();
    const events = harness.stdout.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );

    expect(events[events.length - 1]).toMatchObject({
      event: "command.completed",
      status: "needs_action",
      next: { command: "foundry deploy --resume --plan-file plan.json --json" },
    });
  });

  it("commits a signed create intent before the create it cannot make idempotent", async () => {
    const harness = await createHarness();
    await harness.run();

    const receipts = await harness.provisioningState.read();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      sequence: 0,
      previousReceiptHash: null,
      installationId,
      deploymentId,
      payload: { kind: "resource.create-intent" },
    });
    expect(JSON.stringify(receipts)).not.toContain("9f1c0a2b3d4e5f60718293a4b5c6d7e8");
  });

  it("names every provider resource from the deployment, not the label alone", async () => {
    const harness = await createHarness();
    const result = await harness.run();
    const database = result.resources.find(
      (resource) => resource.resourceKind === "d1",
    );

    expect(database?.displayName).toBe(resourceNameFor(harness.bound, "d1"));
    expect(database?.displayName).toContain(harness.bound.resourceSuffix);
    expect(database?.installationId).toBe(installationId);
    expect(database?.deploymentId).toBe(deploymentId);
    expect(database?.providerResourceId).toBe(
      "8f0b1c2d-3e4f-5061-7283-94a5b6c7d8e9",
    );
    expect(database?.observedFingerprint).toBe(database?.desiredFingerprint);
    expect(database?.adopted).toBe(false);
  });

  it("refuses a step that claims verified without its declared health evidence", async () => {
    const harness = await createHarness({ underVerifyAccessStep: true });

    await expect(harness.run()).rejects.toThrow(
      /create_flow_health_evidence_missing:cloudflare\.access/u,
    );
  });

  it("verifies every step before its dependants run", async () => {
    const harness = await createHarness();
    const result = await harness.run();

    for (const step of result.steps) {
      expect(step.status).toBe("verified");
      expect(step.verifiedChecks.length).toBeGreaterThan(0);
    }

    const order = harness.stdout
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.event === "step.changed")
      .map((event) => event.stepId);

    expect(order.indexOf("cloudflare.worker.bootstrap")).toBeGreaterThan(
      order.indexOf("cloudflare.d1"),
    );
    expect(order.indexOf("cloudflare.route")).toBeGreaterThan(
      order.indexOf("cloudflare.access"),
    );
    expect(order.indexOf("owner.invitation")).toBeGreaterThan(
      order.indexOf("cloudflare.route"),
    );
  });

  it("pauses on a client authorization and resumes from the journal", async () => {
    const harness = await createHarness({ pauseOnPublisherApp: true });

    const paused = await harness.run();
    expect(paused.status).toBe("needs_action");
    expect(paused.exitCode).toBe(operatorExitCodes.clientActionRequired);
    // The publisher App belongs to `runtime_bound`, so pausing on it leaves the
    // installation at the last state whose steps are all verified.
    expect(paused.state).toBe("resources_ready");
    expect(paused.report).toBeNull();

    const action = harness.stdout
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((event) => event.event === "action.required");
    expect(action).toMatchObject({
      stepId: "github.publisher-app",
      action: { kind: "browser_authorization" },
    });

    const resumed = await harness.run();
    expect(resumed.status).toBe("verified");
    expect(resumed.state).toBe("verification_ready");
  });

  it("fails the command when the create verification profile fails", async () => {
    const harness = await createHarness({ failDashProtection: true });
    const result = await harness.run();

    expect(result.status).toBe("verification_failed");
    expect(result.exitCode).toBe(operatorExitCodes.verificationFailed);
    expect(
      result.report?.checks.find(
        (entry) => entry.checkId === "auth.dash-protected",
      )?.code,
    ).toBe("auth.protected_path_reachable");
  });

  it("moves a real secret to provider storage without it entering state or output", async () => {
    const harness = await createHarness();
    await harness.run();

    expect(harness.uploadedSecrets).toEqual([brevoApiKey]);
    expect(harness.brevoSlot.health).toBe("verified");
    expect(JSON.stringify(harness.brevoSlot)).not.toContain("xkeysib");

    const stream = harness.stdout.join("\n");
    expect(stream).not.toContain("xkeysib");
    expect(stream.length).toBeGreaterThan(0);
    for (const line of harness.stdout) {
      expect(JSON.parse(line)).toMatchObject({
        schemaVersion: "foundry.operator/v1",
      });
    }
  });

  it("stops provisioning when the output stream seals on credential material", async () => {
    const harness = await createHarness({ leakOnAccessStep: true });
    const result = await harness.run();

    expect(harness.output.sealed).toBe(true);
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(
      operatorExitCodes.securityInvariantViolation,
    );
    expect(result.report).toBeNull();
    // Nothing after the sealed step ran.
    expect(
      result.steps.some((step) => step.stepId === "cloudflare.route"),
    ).toBe(false);
    expect(harness.stdout.join("\n")).toContain("security.output_redacted");
    expect(harness.stdout.join("\n")).not.toContain("ghp_");
  });

  it("keeps the emitted stream free of any credential-shaped value", async () => {
    const harness = await createHarness();
    await harness.run();

    expect(harness.output.sealed).toBe(false);
    expect(harness.output.exitCode).toBe(operatorExitCodes.verified);
  });

  it("declares a credential slot for every secret it installed", async () => {
    const harness = await createHarness();
    await harness.run();

    expect(() =>
      assertDeclaredCredentialSlotsSatisfied({
        declaredSlotIds: ["brevo_api_key"],
        slots: [harness.brevoSlot],
      }),
    ).not.toThrow();
  });

  it("commits a public-safe bootstrap manifest naming both identities", async () => {
    const harness = await createHarness();
    const manifest = createBootstrapManifest({
      identity: harness.bound,
      productionBranch: harness.plan.inputs.productionBranch,
      canonicalHostname: harness.plan.inputs.canonicalHostname,
      foundationRelease: {
        version: harness.plan.inputs.foundationReleaseVersion,
        digest: harness.plan.inputs.foundationReleaseDigest,
      },
      accountScopeFingerprints: {
        github: harness.plan.inputs.githubAccountScopeFingerprint,
        cloudflare: harness.plan.inputs.cloudflareAccountScopeFingerprint,
      },
      resourceNames: {
        d1: resourceNameFor(harness.bound, "d1"),
        r2: resourceNameFor(harness.bound, "r2"),
        worker: resourceNameFor(harness.bound, "worker"),
      },
      provisioningReceiptVerificationKey: "A".repeat(43) + "=",
    });

    expect(manifest.installationId).toBe(installationId);
    expect(manifest.activeDeploymentId).toBe(deploymentId);
    expect(JSON.stringify(manifest)).not.toContain(
      "9f1c0a2b3d4e5f60718293a4b5c6d7e8",
    );
  });
});

describe("the reviewed plan binds the operation", () => {
  it("parses the documented invocation and re-checks the plan", async () => {
    const invocation = parseOperatorCommandLine([
      "deploy",
      "--plan-file",
      "plan.json",
      "--json",
    ]);
    expect(invocation).toMatchObject({ command: "deploy", json: true });

    const plan = await parseOperatorPlan(await planFileContents());
    await expect(
      assertPlanStillApplies({ plan, observedInputs: plan.inputs }),
    ).resolves.toBeUndefined();
  });

  it("stops when the observed account no longer matches the reviewed plan", async () => {
    const plan = await parseOperatorPlan(await planFileContents());

    await expect(
      assertPlanStillApplies({
        plan,
        observedInputs: {
          ...plan.inputs,
          cloudflareAccountScopeFingerprint: await computeAccountScopeFingerprint(
            {
              provider: "cloudflare",
              accountId: "0000000000000000000000000000dead",
              installationId,
              deploymentId,
            },
          ),
        },
      }),
    ).rejects.toThrow(/plan_inputs_changed/u);
  });

  it("gives every step the reviewed plan's input hash", async () => {
    const plan = await parseOperatorPlan(await planFileContents());
    const step = createProvisioningStep({
      stepId: "cloudflare.d1",
      inputHash: plan.inputHash,
      createdAt: "2026-07-27T00:00:00.000Z",
    });

    expect(step.inputHash).toBe(plan.inputHash);
  });
});
