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

/**
 * One plain sentence per reason code the members API can return for a
 * refused access change. Each key is either the top-level `error` field
 * (`last_owner`) or the `reason` field the API sends alongside
 * `error: "not_authorized"` (the `AccessDeniedError` code — see
 * `commandErrorResponse` in `app/api/foundry-cms/members/route.ts`).
 *
 * Every sentence names the actual cause. No internal code or enum string
 * from this table ever reaches the screen.
 */
const humanAccessMutationFailureReasonSentences: Readonly<
  Record<string, string>
> = {
  last_owner:
    "The site must always have one Owner, so make another person an Owner first.",
  membership_transition_not_allowed:
    "This person's access is already revoked, so it cannot be changed further.",
  membership_email_ambiguous:
    "That email address is not valid, or is already invited.",
  capability_not_authorized: "You do not have permission to make this change.",
  membership_not_active: "You do not have permission to make this change.",
  membership_not_found:
    "This person could not be found. Refresh the page and try again.",
  campaign_test_send_in_progress:
    "A campaign test send is in progress. Try again once it finishes.",
  invitation_not_claimable:
    "That invitation cannot be accepted. It may have expired or already been used.",
};

const genericHumanAccessMutationFailureSentence =
  "Access change was not applied.";

/**
 * The one plain sentence a site owner reads when an access change is
 * refused. Reads the API's `reason` field first (the exact cause behind a
 * generic `not_authorized` refusal), falling back to the top-level `error`
 * field (`last_owner` has no separate `reason`). An error code this table
 * does not know keeps the generic sentence — never an internal code or enum
 * string.
 */
export function humanAccessMutationFailureMessage(body: unknown): string {
  if (typeof body !== "object" || body === null) {
    return genericHumanAccessMutationFailureSentence;
  }
  const reason =
    "reason" in body && typeof body.reason === "string"
      ? body.reason
      : "error" in body && typeof body.error === "string"
        ? body.error
        : null;
  if (reason !== null && reason in humanAccessMutationFailureReasonSentences) {
    return humanAccessMutationFailureReasonSentences[reason];
  }
  return genericHumanAccessMutationFailureSentence;
}

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

/**
 * The question asked before a role change takes effect. A role change is
 * significant enough — it grants or removes Owner tasks such as managing
 * users, connections and subscriber details — that it always asks first,
 * unlike reactivating a suspended user.
 */
export function roleChangeConfirmation(
  email: string,
  role: "owner" | "editor",
): string {
  if (role === "owner") {
    return `Make ${email} an Owner? They will be able to manage users, connections and everything an Editor can.`;
  }
  return `Make ${email} an Editor? They will lose Owner tasks such as managing users, connections and subscriber details.`;
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
