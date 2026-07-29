/**
 * One error shape for the whole operator package.
 *
 * Every failure carries a stable machine `code`. Provider prose is never the
 * message, because an operator error is also output and the output contract
 * treats provider text as untrusted and subordinate.
 *
 * Two code shapes, one rule. A code that never leaves the process is bare
 * snake_case, matching the rest of the repository: `plan_input_hash_mismatch`,
 * `credential_upload_unverified`. A code that crosses the machine-readable
 * output boundary as an event's `code` field takes a dotted namespace, matching
 * the `security.output_redacted` the operator contract itself specifies:
 * `reconcile.readback_mismatch`, `adoption.name_mismatch`.
 */

export class OperatorError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = new.target.name;
    this.code = code;
  }
}

/**
 * Requires a non-empty string and returns it trimmed. The rejected value is
 * never included in the error, because the value may be the thing that must
 * not be printed.
 */
export function requireText<ErrorType extends OperatorError>(
  value: unknown,
  code: string,
  createError: (code: string) => ErrorType,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw createError(code);
  }
  return value.trim();
}
