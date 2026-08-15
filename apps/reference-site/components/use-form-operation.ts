"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * One way to send a Messages command to the CMS.
 *
 * Every command is idempotent at the API, so a repeated request can never
 * apply twice. An outcome of "unconfirmed" means the browser never saw an
 * answer: the command may or may not have run, so the person is told to
 * reload rather than press the button again.
 */
export type FormOperationOutcome = "applied" | "refused" | "unconfirmed";

export type FormOperationMessages = Readonly<
  Record<FormOperationOutcome, string>
>;

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

/**
 * The state every Messages control needs: whether a command is in flight,
 * what to tell the person about the last one, and a refresh once it applied.
 */
export function useFormOperation(
  csrfToken: string,
  messages: FormOperationMessages,
) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  async function run(command: unknown) {
    return report(async () => {
      const outcome = await applyFormOperation(command, csrfToken);
      if (outcome === "applied") router.refresh();
      return messages[outcome];
    });
  }

  /**
   * For work that is not a command with an outcome — downloading a copy, for
   * one — where the caller decides what to say. It owns the busy state and
   * the message so no caller has to hold React state of its own.
   */
  async function report(work: () => Promise<string>) {
    setPending(true);
    setMessage("");
    try {
      setMessage(await work());
    } finally {
      setPending(false);
    }
  }

  return { message, pending, report, run };
}
