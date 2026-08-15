/**
 * One way to send a Messages command to the CMS.
 *
 * Every command is idempotent at the API, so a repeated request can never
 * apply twice. An outcome of "unconfirmed" means the browser never saw an
 * answer: the command may or may not have run, so the person is told to
 * refresh rather than press the button again.
 */
export type FormOperationOutcome = "applied" | "refused" | "unconfirmed";

export async function applyFormOperation(
  command: unknown,
  csrfToken: string,
): Promise<FormOperationOutcome> {
  try {
    const response = await fetch("/api/foundry-cms/forms", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
        "x-foundry-csrf": csrfToken,
      },
      body: JSON.stringify(command),
    });
    return response.ok ? "applied" : "refused";
  } catch {
    return "unconfirmed";
  }
}
