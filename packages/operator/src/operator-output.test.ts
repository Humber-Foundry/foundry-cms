import { describe, expect, it, vi } from "vitest";

import {
  InvalidOperatorEventError,
  operatorExitCodes,
  operatorSchemaVersion,
  createOperatorOutput,
} from "./operator-output";

const operationId = "01984f2a-1c00-7000-8000-000000000001";
const installationId = "01984f2a-1c00-7000-8000-0000000000aa";
const deploymentId = "01984f2a-1c00-7000-8000-0000000000bb";

function scoped() {
  return {
    operationId,
    installationId,
    deploymentId,
    deploymentRole: "target",
  } as const;
}

function createHarness({ json = true }: { json?: boolean } = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const output = createOperatorOutput({
    command: "deploy",
    json,
    writeOut: (line: string) => stdout.push(line),
    writeDiagnostic: (line: string) => stderr.push(line),
    operationId,
  });
  return { output, stdout, stderr };
}

function parsed(stdout: ReadonlyArray<string>) {
  return stdout.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("newline-delimited JSON contract", () => {
  it("stamps the schema version on every line and emits no prose", () => {
    const { output, stdout, stderr } = createHarness();

    output.emit({
      event: "command.started",
      command: "deploy",
      ...scoped(),
      inputHash: `sha256:${"a".repeat(64)}`,
      cliVersion: "1.4.0",
    });
    output.emit({
      event: "step.changed",
      ...scoped(),
      stepId: "cloudflare.d1",
      status: "applied_unverified",
      attempt: 1,
      resource: { kind: "d1", name: "acme-kmnpqrstuvwxyzab" },
    });

    expect(stdout).toHaveLength(2);
    for (const line of stdout) {
      expect(line).not.toContain("\n");
      expect(JSON.parse(line)).toMatchObject({
        schemaVersion: operatorSchemaVersion,
      });
    }
    expect(stderr).toEqual([]);
  });

  it("stamps the emitter's own operation id on every event", () => {
    const { output, stdout } = createHarness();

    output.emit({
      event: "warning",
      installationId,
      deploymentId,
      deploymentRole: "target",
      code: "quota.warning",
    } as never);

    expect(parsed(stdout)[0]?.operationId).toBe(operationId);
  });

  it("keeps human progress on stderr and JSON on stdout", () => {
    const { output, stdout, stderr } = createHarness();
    output.progress("Creating the D1 database…");

    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["Creating the D1 database…"]);
  });

  it("writes human prose to stdout when JSON output is not requested", () => {
    const { output, stdout } = createHarness({ json: false });

    output.emit({
      event: "step.changed",
      ...scoped(),
      stepId: "cloudflare.d1",
      status: "verified",
      attempt: 1,
    });

    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toContain("cloudflare.d1");
    expect(() => JSON.parse(stdout[0] as string)).toThrow();
  });
});

describe("deny-by-default field allowlist", () => {
  it("discards fields the event schema does not name", () => {
    const { output, stdout } = createHarness();

    output.emit({
      event: "check.completed",
      ...scoped(),
      checkId: "auth.protected-routes",
      status: "pass",
      observedAt: "2026-07-27T00:10:00.000Z",
      evidenceRef: "check:auth.protected-routes:7",
      providerResponseBody: "{\"result\":\"ok\"}",
      operatorEmail: "operator@example.com",
    } as never);

    const [event] = parsed(stdout);
    expect(event).toEqual({
      schemaVersion: operatorSchemaVersion,
      event: "check.completed",
      operationId,
      installationId,
      deploymentId,
      deploymentRole: "target",
      checkId: "auth.protected-routes",
      status: "pass",
      observedAt: "2026-07-27T00:10:00.000Z",
      evidenceRef: "check:auth.protected-routes:7",
    });
  });

  it("discards unnamed fields inside a nested allowlisted object", () => {
    const { output, stdout } = createHarness();

    output.emit({
      event: "step.changed",
      ...scoped(),
      stepId: "cloudflare.d1",
      status: "verified",
      attempt: 2,
      resource: {
        kind: "d1",
        name: "acme-kmnpqrstuvwxyzab",
        providerResourceId: "8f0b1c2d",
        connectionString: "d1://acme",
      },
    } as never);

    expect(parsed(stdout)[0]?.resource).toEqual({
      kind: "d1",
      name: "acme-kmnpqrstuvwxyzab",
      providerResourceId: "8f0b1c2d",
    });
  });

  it("rejects an event name outside the closed vocabulary", () => {
    const { output } = createHarness();

    expect(() =>
      output.emit({ event: "secret.leaked", ...scoped() } as never),
    ).toThrow(InvalidOperatorEventError);
  });

  it("rejects an event missing a required field", () => {
    const { output } = createHarness();

    expect(() =>
      output.emit({
        event: "check.completed",
        ...scoped(),
        checkId: "auth.protected-routes",
        observedAt: "2026-07-27T00:10:00.000Z",
      } as never),
    ).toThrow(InvalidOperatorEventError);
  });

  it("rejects a deployment-scoped event with no deployment role", () => {
    const { output } = createHarness();

    expect(() =>
      output.emit({
        event: "step.changed",
        operationId,
        installationId,
        deploymentId,
        stepId: "cloudflare.d1",
        status: "verified",
        attempt: 1,
      } as never),
    ).toThrow(InvalidOperatorEventError);
  });

  it("carries both deployment ids for a cross-account operation", () => {
    const { output, stdout } = createHarness();

    output.emit({
      event: "command.started",
      command: "migrate",
      operationId,
      installationId,
      deploymentId,
      deploymentRole: "target",
      sourceDeploymentId: "01984f2a-1c00-7000-8000-0000000000cc",
      targetDeploymentId: deploymentId,
      inputHash: `sha256:${"a".repeat(64)}`,
      cliVersion: "1.4.0",
    });

    expect(parsed(stdout)[0]).toMatchObject({
      sourceDeploymentId: "01984f2a-1c00-7000-8000-0000000000cc",
      targetDeploymentId: deploymentId,
      deploymentRole: "target",
    });
  });
});

describe("credential-shaped material", () => {
  it("discards the whole event, warns with a stable code and fails closed", () => {
    const { output, stdout } = createHarness();

    output.emit({
      event: "action.required",
      ...scoped(),
      stepId: "cloudflare.builds.authorization",
      action: {
        kind: "browser_authorization",
        url: "https://dash.cloudflare.com/x/workers?api_token=abcdefghijklmnopqrst",
        expiresAt: "2026-07-27T01:00:00.000Z",
      },
    });

    const events = parsed(stdout);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      schemaVersion: operatorSchemaVersion,
      event: "warning",
      operationId,
      code: "security.output_redacted",
    });
    expect(events[1]).toMatchObject({
      event: "command.completed",
      status: "failed",
    });
    expect(stdout.join("\n")).not.toContain("api_token");
    expect(output.exitCode).toBe(operatorExitCodes.securityInvariantViolation);
  });

  it("never partially masks the rejected material", () => {
    const { output, stdout } = createHarness();

    output.emit({
      event: "step.changed",
      ...scoped(),
      stepId: "github.publisher-app",
      status: "verified",
      attempt: 1,
      code: "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
    });

    expect(stdout.join("\n")).not.toContain("ghp_");
    expect(stdout.join("\n")).not.toContain("***");
    expect(stdout.join("\n")).not.toContain("REDACTED");
  });

  it("stops all further writes once output is sealed", () => {
    const { output, stdout } = createHarness();

    output.emit({
      event: "warning",
      ...scoped(),
      code: "-----BEGIN RSA PRIVATE KEY-----",
    });
    const sealedLength = stdout.length;

    output.emit({
      event: "check.completed",
      ...scoped(),
      checkId: "auth.protected-routes",
      status: "pass",
      observedAt: "2026-07-27T00:10:00.000Z",
    });
    output.progress("still working");

    expect(stdout).toHaveLength(sealedLength);
    expect(output.exitCode).toBe(operatorExitCodes.securityInvariantViolation);
  });

  it("seals human output mode without printing the material", () => {
    const { output, stdout } = createHarness({ json: false });

    output.emit({
      event: "step.changed",
      ...scoped(),
      stepId: "github.publisher-app",
      status: "verified",
      attempt: 1,
      code: "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
    });

    expect(stdout.join("\n")).not.toContain("ghp_");
    expect(stdout.join("\n")).toContain("security.output_redacted");
    expect(output.exitCode).toBe(operatorExitCodes.securityInvariantViolation);
  });
});

describe("terminal result", () => {
  it("reports the resumable next command and the matching exit code", () => {
    const { output, stdout } = createHarness();

    output.complete({
      command: "deploy",
      ...scoped(),
      status: "needs_action",
      summary: { passed: 18, failed: 0, pending: 1 },
      next: { command: "foundry deploy --resume --json" },
    });

    expect(parsed(stdout)[0]).toEqual({
      schemaVersion: operatorSchemaVersion,
      event: "command.completed",
      command: "deploy",
      operationId,
      installationId,
      deploymentId,
      deploymentRole: "target",
      status: "needs_action",
      summary: { passed: 18, failed: 0, pending: 1 },
      next: { command: "foundry deploy --resume --json" },
    });
    expect(output.exitCode).toBe(operatorExitCodes.clientActionRequired);
  });

  it("maps every terminal status to its documented exit code", () => {
    const cases = [
      ["verified", operatorExitCodes.verified],
      ["needs_action", operatorExitCodes.clientActionRequired],
      ["retryable_failure", operatorExitCodes.retryableFailure],
      ["preflight_blocked", operatorExitCodes.preflightBlocked],
      ["review_required", operatorExitCodes.reviewRequired],
      ["verification_failed", operatorExitCodes.verificationFailed],
      ["invalid_input", operatorExitCodes.invalidInput],
      ["failed", operatorExitCodes.securityInvariantViolation],
    ] as const;

    for (const [status, code] of cases) {
      const { output } = createHarness();
      output.complete({
        command: "deploy",
        ...scoped(),
        status,
        summary: { passed: 0, failed: 0, pending: 0 },
      });
      expect(output.exitCode).toBe(code);
    }
  });

  it("refuses a next command carrying a credential argument", () => {
    const { output, stdout } = createHarness();

    output.complete({
      command: "deploy",
      ...scoped(),
      status: "needs_action",
      summary: { passed: 0, failed: 0, pending: 1 },
      next: { command: "foundry deploy --token ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8" },
    });

    expect(stdout.join("\n")).not.toContain("ghp_");
    expect(output.exitCode).toBe(operatorExitCodes.securityInvariantViolation);
  });

  it("emits exactly one terminal event", () => {
    const { output, stdout } = createHarness();
    const complete = () =>
      output.complete({
        command: "scaffold",
        ...scoped(),
        status: "verified",
        summary: { passed: 1, failed: 0, pending: 0 },
      });

    complete();
    expect(() => complete()).toThrow(InvalidOperatorEventError);
    expect(stdout).toHaveLength(1);
  });
});

describe("write failures", () => {
  it("surfaces a broken stdout rather than continuing silently", () => {
    const writeOut = vi.fn(() => {
      throw new Error("EPIPE");
    });
    const output = createOperatorOutput({
      command: "deploy",
      json: true,
      writeOut,
      writeDiagnostic: () => undefined,
      operationId,
    });

    expect(() =>
      output.emit({
        event: "warning",
        ...scoped(),
        code: "quota.warning",
      }),
    ).toThrow("EPIPE");
  });
});
