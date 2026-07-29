import { describe, expect, it } from "vitest";

import {
  OperatorUsageError,
  defaultVerificationProfile,
  operatorCommands,
  parseOperatorCommandLine,
  quoteShellArgument,
  resumableCommandLine,
  resumableCommands,
  verificationProfiles,
} from "./operator-cli";
import { operatorExitCodes } from "./operator-output";

describe("command surface", () => {
  it("accepts only the five documented v1 commands", () => {
    expect([...operatorCommands]).toEqual([
      "scaffold",
      "deploy",
      "migrate",
      "verify",
      "diagnose",
    ]);
  });

  it("rejects an undocumented command", () => {
    for (const command of ["publish", "edit", "send", "rotate"]) {
      expect(() => parseOperatorCommandLine([command])).toThrow(
        OperatorUsageError,
      );
    }
  });

  it("rejects a positional argument", () => {
    expect(() => parseOperatorCommandLine(["scaffold", "acme"])).toThrow(
      /usage_positional_argument_unsupported/u,
    );
  });

  it("rejects an unknown flag", () => {
    expect(() =>
      parseOperatorCommandLine(["deploy", "--plan-file", "p.json", "--force"]),
    ).toThrow(/usage_flag_unknown/u);
  });

  it("rejects a repeated flag", () => {
    expect(() =>
      parseOperatorCommandLine([
        "deploy",
        "--plan-file",
        "a.json",
        "--plan-file",
        "b.json",
      ]),
    ).toThrow(/usage_flag_repeated/u);
  });

  it("parses both separated and inline flag values", () => {
    expect(
      parseOperatorCommandLine(["deploy", "--plan-file", "plan.json", "--json"]),
    ).toEqual({
      command: "deploy",
      json: true,
      profile: undefined,
      flags: { "plan-file": "plan.json", json: true },
    });
    expect(
      parseOperatorCommandLine(["deploy", "--plan-file=plan.json"]).flags,
    ).toEqual({ "plan-file": "plan.json" });
  });

  it("rejects a value-taking flag with no value", () => {
    expect(() =>
      parseOperatorCommandLine(["deploy", "--plan-file"]),
    ).toThrow(/usage_flag_value_missing/u);
    expect(() =>
      parseOperatorCommandLine(["deploy", "--plan-file", "--json"]),
    ).toThrow(/usage_flag_value_missing/u);
  });

  it("rejects a value given to a boolean flag", () => {
    expect(() =>
      parseOperatorCommandLine(["scaffold", "--plan=yes"]),
    ).toThrow(/usage_flag_value_unexpected/u);
  });
});

describe("no credential ever enters an argument", () => {
  it("has no flag that accepts a credential", () => {
    for (const command of operatorCommands) {
      for (const flag of ["--token", "--secret", "--api-key", "--password"]) {
        expect(() => parseOperatorCommandLine([command, flag, "x"])).toThrow(
          /usage_flag_unknown/u,
        );
      }
    }
  });

  it("stops the invocation when any argument value looks like a credential", () => {
    const error = (() => {
      try {
        parseOperatorCommandLine([
          "deploy",
          "--plan-file",
          "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
        ]);
        return null;
      } catch (thrown) {
        return thrown;
      }
    })();

    expect(error).toBeInstanceOf(OperatorUsageError);
    expect((error as OperatorUsageError).code).toBe(
      "security.credential_in_argument",
    );
    expect((error as OperatorUsageError).exitCode).toBe(
      operatorExitCodes.securityInvariantViolation,
    );
  });

  it("never repeats the rejected argument value in the error", () => {
    try {
      parseOperatorCommandLine([
        "verify",
        "--profile",
        "smoke",
        "--plan-file",
        "xkeysib-0a1b2c3d4e5f60718293a4b5c6d7e8f90",
      ]);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain("xkeysib");
    }
  });
});

describe("scaffold", () => {
  it("requires exactly one of --plan or --plan-file", () => {
    expect(parseOperatorCommandLine(["scaffold", "--plan"]).flags).toEqual({
      plan: true,
    });
    expect(parseOperatorCommandLine(["scaffold", "--plan"]).profile).toBeUndefined();
    expect(() => parseOperatorCommandLine(["scaffold"])).toThrow(
      /usage_plan_mode_required/u,
    );
    expect(() =>
      parseOperatorCommandLine(["scaffold", "--plan", "--plan-file", "p.json"]),
    ).toThrow(/usage_plan_mode_required/u);
  });

  it("accepts --from-site as an input to either mode", () => {
    expect(
      parseOperatorCommandLine([
        "scaffold",
        "--plan",
        "--from-site",
        "./site",
      ]).flags,
    ).toEqual({ plan: true, "from-site": "./site" });
  });
});

describe("deploy", () => {
  it("requires the reviewed plan for a first run", () => {
    expect(() => parseOperatorCommandLine(["deploy"])).toThrow(
      /usage_plan_file_required/u,
    );
  });

  it("accepts the contract's own resumable command with no plan file", () => {
    expect(
      parseOperatorCommandLine(["deploy", "--resume", "--json"]),
    ).toMatchObject({ command: "deploy", json: true });
  });

  it("treats --resume as the ordinary continuation path", () => {
    expect(
      parseOperatorCommandLine([
        "deploy",
        "--resume",
        "--plan-file",
        "plan.json",
      ]).flags,
    ).toEqual({ resume: true, "plan-file": "plan.json" });
  });

  it("accepts a resolution file only while resuming", () => {
    expect(() =>
      parseOperatorCommandLine([
        "deploy",
        "--plan-file",
        "plan.json",
        "--resolution-file",
        "fix.json",
      ]),
    ).toThrow(/usage_resolution_requires_resume/u);

    expect(
      parseOperatorCommandLine([
        "deploy",
        "--resume",
        "--plan-file",
        "plan.json",
        "--resolution-file",
        "fix.json",
      ]).flags["resolution-file"],
    ).toBe("fix.json");
  });
});

describe("verify", () => {
  it("runs the read-only smoke profile when none is named", () => {
    expect(parseOperatorCommandLine(["verify"]).profile).toBe("smoke");
    expect(defaultVerificationProfile).toBe("smoke");
  });

  it("requires a documented profile", () => {
    expect(() =>
      parseOperatorCommandLine(["verify", "--profile", "quick"]),
    ).toThrow(/usage_profile_unknown/u);
    expect([...verificationProfiles]).toEqual([
      "smoke",
      "full",
      "pre-handoff",
      "handoff",
      "upgrade",
    ]);
  });

  it("lets the read-only smoke profile run without a plan", () => {
    expect(
      parseOperatorCommandLine(["verify", "--profile", "smoke"]).flags,
    ).toEqual({ profile: "smoke" });
  });

  it("requires an explicit plan for every ceremony profile", () => {
    for (const profile of ["full", "pre-handoff", "handoff", "upgrade"]) {
      expect(() =>
        parseOperatorCommandLine(["verify", "--profile", profile]),
      ).toThrow(/usage_verification_ceremony_requires_plan/u);
      expect(
        parseOperatorCommandLine(["verify", "--profile", profile, "--plan"])
          .command,
      ).toBe("verify");
    }
  });
});

describe("diagnose", () => {
  it("is read-only and needs a named check to propose a repair plan", () => {
    expect(parseOperatorCommandLine(["diagnose"]).flags).toEqual({});
    expect(() =>
      parseOperatorCommandLine(["diagnose", "--repair-plan"]),
    ).toThrow(/usage_repair_plan_requires_check/u);
    expect(
      parseOperatorCommandLine([
        "diagnose",
        "--check",
        "credential-rotation",
        "--repair-plan",
      ]).flags,
    ).toEqual({ check: "credential-rotation", "repair-plan": true });
  });
});

describe("resumable command line", () => {
  it("names a safe continuation with no credential argument", () => {
    expect(
      resumableCommandLine({
        command: "deploy",
        planFile: "plan.json",
        json: true,
      }),
    ).toBe("foundry deploy --resume --plan-file plan.json --json");
  });

  it("offers a next command only for a command whose surface has --resume", () => {
    expect([...resumableCommands]).toEqual(["deploy", "migrate"]);

    for (const command of resumableCommands) {
      const line = resumableCommandLine({
        command,
        planFile: "plan.json",
        json: true,
      });
      expect(() =>
        parseOperatorCommandLine(line.split(" ").slice(1)),
      ).not.toThrow();
    }
  });

  it("quotes a plan path a shell would otherwise split or interpret", () => {
    expect(
      resumableCommandLine({
        command: "deploy",
        planFile: "plans/acme site.json",
        json: false,
      }),
    ).toBe("foundry deploy --resume --plan-file 'plans/acme site.json'");

    expect(
      resumableCommandLine({
        command: "deploy",
        planFile: "plan;rm -rf /.json",
        json: false,
      }),
    ).toContain("'plan;rm -rf /.json'");

    // The shell-safe form of `it's.json` is 'it'\''s.json' — one backslash.
    expect(quoteShellArgument("it's.json")).toBe("'it'\\''s.json'");
    expect([...quoteShellArgument("it's.json")].filter((c) => c === "\\")).toHaveLength(
      1,
    );
  });

  it("re-parses as a valid invocation", () => {
    const line = resumableCommandLine({
      command: "deploy",
      planFile: "plan.json",
      json: true,
    });
    expect(
      parseOperatorCommandLine(line.split(" ").slice(1).flatMap((part) => part.split(" "))),
    ).toMatchObject({ command: "deploy", json: true });
  });
});
