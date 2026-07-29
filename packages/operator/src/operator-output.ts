/**
 * The operator CLI's machine-readable output contract.
 *
 * Every stdout line in `--json` mode is one schema-valid event. The emitter is
 * deny-by-default: a field the event schema does not name is discarded, and any
 * value that looks like credential material discards the whole event, seals the
 * stream and fails the command. Nothing is partially masked, because a masked
 * secret is still a leaked shape.
 */

import { OperatorError } from "./operator-errors";
import { containsCredentialMaterial } from "./secret-material";

export const operatorSchemaVersion = "foundry.operator/v1";

export const operatorExitCodes: Readonly<{
  verified: number;
  clientActionRequired: number;
  retryableFailure: number;
  preflightBlocked: number;
  reviewRequired: number;
  verificationFailed: number;
  invalidInput: number;
  securityInvariantViolation: number;
}> = Object.freeze({
  verified: 0,
  clientActionRequired: 2,
  retryableFailure: 3,
  preflightBlocked: 4,
  reviewRequired: 5,
  verificationFailed: 6,
  invalidInput: 7,
  securityInvariantViolation: 8,
});

export type OperatorCommand =
  | "scaffold"
  | "deploy"
  | "migrate"
  | "verify"
  | "diagnose";

export type OperatorEventName =
  | "command.started"
  | "step.changed"
  | "action.required"
  | "check.completed"
  | "warning"
  | "command.completed";

export type OperatorTerminalStatus =
  | "verified"
  | "needs_action"
  | "retryable_failure"
  | "preflight_blocked"
  | "review_required"
  | "verification_failed"
  | "invalid_input"
  | "failed";

/**
 * The account-bound resource set an event acted on. Every deployment-scoped
 * event carries it so automation never infers deployment identity from a
 * resource name or a mutable active-deployment pointer.
 */
export type DeploymentScope = Readonly<{
  installationId: string;
  deploymentId: string;
  deploymentRole: "source" | "target";
}>;

const terminalExitCodes: Readonly<Record<OperatorTerminalStatus, number>> =
  Object.freeze({
    verified: operatorExitCodes.verified,
    needs_action: operatorExitCodes.clientActionRequired,
    retryable_failure: operatorExitCodes.retryableFailure,
    preflight_blocked: operatorExitCodes.preflightBlocked,
    review_required: operatorExitCodes.reviewRequired,
    verification_failed: operatorExitCodes.verificationFailed,
    invalid_input: operatorExitCodes.invalidInput,
    failed: operatorExitCodes.securityInvariantViolation,
  });

export function terminalExitCodeFor(status: OperatorTerminalStatus): number {
  return terminalExitCodes[status];
}

type FieldSchema = Readonly<{
  required: ReadonlyArray<string>;
  optional: ReadonlyArray<string>;
  objects?: Readonly<Record<string, FieldSchema>>;
}>;

const scopeFields = Object.freeze([
  "installationId",
  "deploymentId",
  "deploymentRole",
]);

const scopeOptionalFields = Object.freeze([
  "sourceDeploymentId",
  "targetDeploymentId",
]);

/**
 * Deployment-scoped events must name the account-bound resource set they acted
 * on, so automation never infers it from a resource name or a mutable active
 * pointer. `warning` and `command.completed` may also be emitted before an
 * installation is known — most importantly by the fail-closed redaction path.
 */
function withScope(
  schema: FieldSchema,
  { scoped = true }: { scoped?: boolean } = {},
): FieldSchema {
  return {
    required: [
      "operationId",
      ...(scoped ? scopeFields : []),
      ...schema.required,
    ],
    optional: [
      ...(scoped ? [] : scopeFields),
      ...scopeOptionalFields,
      ...schema.optional,
    ],
    objects: schema.objects,
  };
}

const eventSchemas: Readonly<Record<OperatorEventName, FieldSchema>> =
  Object.freeze({
    "command.started": withScope({
      required: ["command", "inputHash", "cliVersion"],
      optional: [],
    }),
    "step.changed": withScope({
      required: ["stepId", "status", "attempt"],
      optional: ["code", "resource", "evidenceRef"],
      objects: {
        resource: {
          required: ["kind", "name"],
          optional: ["providerResourceId", "lifecycle"],
        },
      },
    }),
    "action.required": withScope({
      required: ["stepId", "action"],
      optional: ["code"],
      objects: {
        action: {
          required: ["kind"],
          optional: ["url", "expiresAt", "instructionRef"],
        },
      },
    }),
    "check.completed": withScope({
      required: ["checkId", "status", "observedAt"],
      optional: ["evidenceRef", "phase", "code", "owner"],
    }),
    warning: withScope(
      {
        required: ["code"],
        optional: ["stepId", "checkId"],
      },
      { scoped: false },
    ),
    "command.completed": withScope(
      {
        required: ["command", "status", "summary"],
        optional: ["next", "code"],
        objects: {
          summary: { required: ["passed", "failed", "pending"], optional: [] },
          next: { required: ["command"], optional: [] },
        },
      },
      { scoped: false },
    ),
  });

const deploymentRoles = Object.freeze(["source", "target"]);

export class InvalidOperatorEventError extends OperatorError {}

export type OperatorEvent = Readonly<Record<string, unknown>> & {
  event: OperatorEventName;
};

function projectObject(
  value: unknown,
  schema: FieldSchema,
  eventName: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidOperatorEventError(`event_field_invalid:${eventName}`);
  }
  const source = value as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const field of schema.required) {
    if (source[field] === undefined || source[field] === null) {
      throw new InvalidOperatorEventError(
        `event_field_missing:${eventName}.${field}`,
      );
    }
    projected[field] = source[field];
  }
  for (const field of schema.optional) {
    if (source[field] !== undefined) {
      projected[field] = source[field];
    }
  }
  for (const [field, nested] of Object.entries(schema.objects ?? {})) {
    if (projected[field] !== undefined) {
      projected[field] = projectObject(
        projected[field],
        nested,
        `${eventName}.${field}`,
      );
    }
  }
  return projected;
}

function projectEvent(event: OperatorEvent): Record<string, unknown> {
  const schema = eventSchemas[event.event];
  if (schema === undefined) {
    throw new InvalidOperatorEventError(`event_name_unknown:${event.event}`);
  }
  const projected = projectObject(event, schema, event.event);
  if (
    projected.deploymentRole !== undefined &&
    !deploymentRoles.includes(String(projected.deploymentRole))
  ) {
    throw new InvalidOperatorEventError("event_deployment_role_invalid");
  }
  if (
    schema.required.includes("deploymentRole") &&
    projected.deploymentRole === undefined
  ) {
    throw new InvalidOperatorEventError("event_deployment_role_invalid");
  }
  return {
    schemaVersion: operatorSchemaVersion,
    event: event.event,
    ...projected,
  };
}

function describeForHumans(event: Record<string, unknown>): string {
  const parts = [String(event.event)];
  for (const field of ["stepId", "checkId", "status", "code", "command"]) {
    const value = event[field];
    if (typeof value === "string" || typeof value === "number") {
      parts.push(`${field}=${value}`);
    }
  }
  return parts.join(" ");
}

export type OperatorOutput = Readonly<{
  emit(event: OperatorEvent): void;
  progress(message: string): void;
  complete(result: DeploymentScope & {
    command: OperatorCommand;
    status: OperatorTerminalStatus;
    summary: { passed: number; failed: number; pending: number };
    next?: { command: string };
    code?: string;
  }): void;
  readonly exitCode: number;
  readonly sealed: boolean;
}>;

export function createOperatorOutput({
  command,
  json,
  writeOut,
  writeDiagnostic,
  operationId,
}: {
  command: OperatorCommand;
  json: boolean;
  writeOut: (line: string) => void;
  writeDiagnostic: (line: string) => void;
  operationId: string;
}): OperatorOutput {
  let exitCode: number = operatorExitCodes.verified;
  let sealed = false;
  let terminated = false;

  function write(line: string): void {
    writeOut(line);
  }

  function seal(): void {
    if (sealed) {
      return;
    }
    sealed = true;
    exitCode = operatorExitCodes.securityInvariantViolation;
    // Built from a fixed safe template and validated by the same projection as
    // every other event, so a fail-closed stream is still schema-valid.
    const warning = projectEvent({
      event: "warning",
      operationId,
      code: "security.output_redacted",
    });
    const failure = projectEvent({
      event: "command.completed",
      operationId,
      command,
      status: "failed",
      summary: { passed: 0, failed: 1, pending: 0 },
    });
    for (const sealedEvent of [warning, failure]) {
      write(
        json ? JSON.stringify(sealedEvent) : describeForHumans(sealedEvent),
      );
    }
    terminated = true;
  }

  function publish(projected: Record<string, unknown>): void {
    if (containsCredentialMaterial(projected)) {
      seal();
      return;
    }
    write(json ? JSON.stringify(projected) : describeForHumans(projected));
  }

  return Object.freeze({
    emit(event: OperatorEvent) {
      if (sealed) {
        return;
      }
      if (terminated) {
        throw new InvalidOperatorEventError("event_after_terminal_result");
      }
      // The command's operation ID is the emitter's own, so a caller can never
      // stamp one event with another operation's identity.
      publish(projectEvent({ ...event, operationId }));
    },
    progress(message: string) {
      if (sealed) {
        return;
      }
      if (containsCredentialMaterial(message)) {
        seal();
        return;
      }
      writeDiagnostic(message);
    },
    complete(result) {
      if (sealed) {
        return;
      }
      if (terminated) {
        throw new InvalidOperatorEventError("event_after_terminal_result");
      }
      const projected = projectEvent({
        ...result,
        operationId,
        event: "command.completed",
      } as OperatorEvent);
      if (containsCredentialMaterial(projected)) {
        seal();
        return;
      }
      terminated = true;
      exitCode = terminalExitCodes[result.status];
      write(json ? JSON.stringify(projected) : describeForHumans(projected));
    },
    get exitCode() {
      return exitCode;
    },
    get sealed() {
      return sealed;
    },
  });
}
