/**
 * The `foundry` operator command surface.
 *
 * The parser is the first place the no-secrets-in-arguments invariant is
 * enforced: there is no flag that accepts a credential, and a credential-shaped
 * argument value stops the invocation before anything is written or printed.
 * Argument values are also never echoed back in an error, because an error
 * message is output too.
 */

import { OperatorError } from "./operator-errors";
import { operatorExitCodes, type OperatorCommand } from "./operator-output";
import { looksLikeCredentialMaterial } from "./secret-material";

export const operatorCommands: ReadonlyArray<OperatorCommand> = Object.freeze([
  "scaffold",
  "deploy",
  "migrate",
  "verify",
  "diagnose",
]);

export const verificationProfiles = Object.freeze([
  "smoke",
  "full",
  "pre-handoff",
  "handoff",
  "upgrade",
] as const);

export type VerificationProfile = (typeof verificationProfiles)[number];

/**
 * `verify` with no profile runs the read-only smoke profile, which is the only
 * one that needs no reviewed plan.
 */
export const defaultVerificationProfile: VerificationProfile = "smoke";

type FlagSpec = Readonly<{ name: string; takesValue: boolean }>;

const commandFlags: Readonly<Record<OperatorCommand, ReadonlyArray<FlagSpec>>> =
  Object.freeze({
    scaffold: [
      { name: "plan", takesValue: false },
      { name: "plan-file", takesValue: true },
      { name: "from-site", takesValue: true },
      { name: "json", takesValue: false },
    ],
    deploy: [
      { name: "resume", takesValue: false },
      { name: "plan-file", takesValue: true },
      { name: "resolution-file", takesValue: true },
      { name: "json", takesValue: false },
    ],
    migrate: [
      { name: "to", takesValue: true },
      { name: "from-installation", takesValue: true },
      { name: "plan", takesValue: false },
      { name: "plan-file", takesValue: true },
      { name: "resume", takesValue: false },
      { name: "json", takesValue: false },
    ],
    verify: [
      { name: "profile", takesValue: true },
      { name: "plan", takesValue: false },
      { name: "plan-file", takesValue: true },
      { name: "json", takesValue: false },
    ],
    diagnose: [
      { name: "check", takesValue: true },
      { name: "repair-plan", takesValue: false },
      { name: "json", takesValue: false },
    ],
  });

export type OperatorInvocation = Readonly<{
  command: OperatorCommand;
  json: boolean;
  profile: VerificationProfile | undefined;
  flags: Readonly<Record<string, string | true>>;
}>;

export class OperatorUsageError extends OperatorError {
  readonly exitCode: number;

  constructor(code: string, exitCode = operatorExitCodes.invalidInput) {
    super(code);
    this.exitCode = exitCode;
  }
}

/**
 * Parses `foundry <command> [flags]`. Only the documented v1 surface is
 * accepted; an unknown command or flag is a usage error rather than something
 * passed through to a provider call.
 */
export function parseOperatorCommandLine(
  argv: ReadonlyArray<string>,
): OperatorInvocation {
  const [commandName, ...rest] = argv;
  if (
    commandName === undefined ||
    !(operatorCommands as ReadonlyArray<string>).includes(commandName)
  ) {
    throw new OperatorUsageError("usage_command_unknown");
  }
  const command = commandName as OperatorCommand;
  const specs = commandFlags[command];
  const flags: Record<string, string | true> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index] as string;
    if (!argument.startsWith("--")) {
      throw new OperatorUsageError("usage_positional_argument_unsupported");
    }
    const separator = argument.indexOf("=");
    const name =
      separator === -1
        ? argument.slice(2)
        : argument.slice(2, separator);
    const spec = specs.find((candidate) => candidate.name === name);
    if (spec === undefined) {
      throw new OperatorUsageError("usage_flag_unknown");
    }
    if (flags[name] !== undefined) {
      throw new OperatorUsageError("usage_flag_repeated");
    }
    if (!spec.takesValue) {
      if (separator !== -1) {
        throw new OperatorUsageError("usage_flag_value_unexpected");
      }
      flags[name] = true;
      continue;
    }
    const inlineValue =
      separator === -1 ? undefined : argument.slice(separator + 1);
    const value = inlineValue ?? rest[index + 1];
    if (inlineValue === undefined) {
      index += 1;
    }
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw new OperatorUsageError("usage_flag_value_missing");
    }
    // No v1 flag accepts a credential. A credential-shaped value means the
    // operator is about to leak one through the process table or shell history.
    if (looksLikeCredentialMaterial(value)) {
      throw new OperatorUsageError(
        "security.credential_in_argument",
        operatorExitCodes.securityInvariantViolation,
      );
    }
    flags[name] = value;
  }

  assertFlagCombination(command, flags);

  return Object.freeze({
    command,
    json: flags.json === true,
    profile:
      command === "verify"
        ? ((flags.profile as VerificationProfile | undefined) ??
          defaultVerificationProfile)
        : undefined,
    flags: Object.freeze(flags),
  });
}

function assertFlagCombination(
  command: OperatorCommand,
  flags: Readonly<Record<string, string | true>>,
): void {
  const hasPlan = flags.plan === true;
  const hasPlanFile = typeof flags["plan-file"] === "string";

  if (command === "scaffold") {
    if (hasPlan === hasPlanFile) {
      throw new OperatorUsageError("usage_plan_mode_required");
    }
  }

  if (command === "deploy") {
    // A first `deploy` executes an exact reviewed plan. A resume continues the
    // operation the journal already records, which is why the contract's own
    // `next` command is `foundry deploy --resume --json`.
    if (!hasPlanFile && flags.resume !== true) {
      throw new OperatorUsageError("usage_plan_file_required");
    }
    if (flags["resolution-file"] !== undefined && flags.resume !== true) {
      throw new OperatorUsageError("usage_resolution_requires_resume");
    }
  }

  if (command === "migrate" && hasPlan && hasPlanFile) {
    throw new OperatorUsageError("usage_plan_mode_ambiguous");
  }

  if (command === "verify") {
    const profile = flags.profile ?? defaultVerificationProfile;
    if (!(verificationProfiles as ReadonlyArray<string>).includes(String(profile))) {
      throw new OperatorUsageError("usage_profile_unknown");
    }
    if (profile !== defaultVerificationProfile && !hasPlan && !hasPlanFile) {
      throw new OperatorUsageError("usage_verification_ceremony_requires_plan");
    }
    if (hasPlan && hasPlanFile) {
      throw new OperatorUsageError("usage_plan_mode_ambiguous");
    }
  }

  if (command === "diagnose" && flags["repair-plan"] === true) {
    if (typeof flags.check !== "string") {
      throw new OperatorUsageError("usage_repair_plan_requires_check");
    }
  }
}

const shellSafeArgumentPattern = /^[A-Za-z0-9_./-]+$/u;

const singleQuote = "'";

const escapedSingleQuote = "'\\''";

/**
 * A path an operator can paste into a shell unchanged. Anything outside the
 * safe set is single-quoted, because a `next` command that splits on a space or
 * runs a metacharacter is not the safe reproduction the contract promises.
 */
export function quoteShellArgument(value: string): string {
  if (shellSafeArgumentPattern.test(value)) {
    return value;
  }
  // A single quote cannot appear inside single quotes, so each one closes the
  // quoting, contributes an escaped quote, and reopens it.
  return `${singleQuote}${value.replaceAll(
    singleQuote,
    escapedSingleQuote,
  )}${singleQuote}`;
}

/**
 * The commands whose surface includes `--resume`. Only these can appear in a
 * terminal event's `next`, so the command an operator is handed always parses.
 */
export const resumableCommands = Object.freeze(["deploy", "migrate"] as const);

export type ResumableCommand = (typeof resumableCommands)[number];

/**
 * The next command an operator can safely run, for the `next` field of a
 * terminal event. It never contains a credential because no flag accepts one.
 */
export function resumableCommandLine({
  command,
  planFile,
  json,
}: {
  command: ResumableCommand;
  planFile: string;
  json: boolean;
}): string {
  const parts = [
    "foundry",
    command,
    "--resume",
    `--plan-file ${quoteShellArgument(planFile)}`,
  ];
  if (json) {
    parts.push("--json");
  }
  return parts.join(" ");
}
