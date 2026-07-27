import {
  humanMutationResultHeader,
  recordedHumanMutationResult,
} from "./human-mutation-protocol";

export interface HumanAccessMutationAttempt {
  readonly body: string;
  readonly idempotencyKey: string;
}

const safeUnrecordedHumanAccessMutationErrors = new Set([
  "idempotency_key_conflict",
  "invalid_command",
  "invalid_idempotency_key",
]);

export function membershipStatusConfirmation(
  email: string,
  status: "active" | "suspended" | "revoked",
): string | null {
  if (status === "suspended") {
    return `Suspend ${email}? They will lose dashboard access until an Owner activates them again.`;
  }
  if (status === "revoked") {
    return `Revoke ${email}? They will lose dashboard access permanently and must receive a new invitation to return.`;
  }
  return null;
}

export function createHumanAccessMutationAttempt(
  command: unknown,
): HumanAccessMutationAttempt {
  return {
    body: JSON.stringify(command),
    idempotencyKey: crypto.randomUUID(),
  };
}

export async function sendHumanAccessMutationAttempt(
  attempt: HumanAccessMutationAttempt,
  csrfToken: string,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const request: RequestInit = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": attempt.idempotencyKey,
      "x-foundry-csrf": csrfToken,
    },
    body: attempt.body,
  };

  try {
    return await fetcher("/api/foundry-cms/members", request);
  } catch {
    return fetcher("/api/foundry-cms/members", request);
  }
}

export async function isHumanAccessMutationInProgress(
  response: Response,
): Promise<boolean> {
  if (response.status !== 409) {
    return false;
  }

  const body: unknown = await response.clone().json().catch(() => null);
  return (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    body.error === "request_in_progress"
  );
}

export async function isHumanAccessMutationRequestCheckFailed(
  response: Response,
): Promise<boolean> {
  if (response.status !== 403) {
    return false;
  }

  const body: unknown = await response.clone().json().catch(() => null);
  return (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    body.error === "request_check_failed"
  );
}

export async function isHumanAccessMutationRequestCheckUnavailable(
  response: Response,
): Promise<boolean> {
  if (response.status !== 503) {
    return false;
  }

  const body: unknown = await response.clone().json().catch(() => null);
  return (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    body.error === "request_check_unavailable"
  );
}

export async function isHumanAccessMutationAmbiguousFailure(
  response: Response,
): Promise<boolean> {
  if (
    response.headers.get(humanMutationResultHeader) ===
    recordedHumanMutationResult
  ) {
    return false;
  }

  const body: unknown = await response.clone().json().catch(() => null);
  const error =
    typeof body === "object" && body !== null && "error" in body
      ? body.error
      : null;
  return (
    typeof error !== "string" ||
    !safeUnrecordedHumanAccessMutationErrors.has(error)
  );
}
