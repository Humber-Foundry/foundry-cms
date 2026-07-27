"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import {
  createHumanAccessMutationAttempt,
  isHumanAccessMutationAmbiguousFailure,
  isHumanAccessMutationInProgress,
  isHumanAccessMutationRequestCheckFailed,
  isHumanAccessMutationRequestCheckUnavailable,
  sendHumanAccessMutationAttempt,
  type HumanAccessMutationAttempt,
} from "../src/human-access-mutation-client";

export function InvitationActivation({
  csrfToken,
  email,
}: {
  csrfToken: string;
  email: string;
}) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [retryAvailable, setRetryAvailable] = useState(false);
  const activationAttempt = useRef<HumanAccessMutationAttempt | null>(null);

  async function activate() {
    setPending(true);
    try {
      if (activationAttempt.current === null) {
        activationAttempt.current = createHumanAccessMutationAttempt({
          action: "claim_invitation",
        });
      }

      let response: Response;
      try {
        response = await sendHumanAccessMutationAttempt(
          activationAttempt.current,
          csrfToken,
        );
      } catch {
        setRetryAvailable(true);
        setMessage(
          "The result could not be confirmed. Retry activation to check the same request.",
        );
        return;
      }

      if (await isHumanAccessMutationInProgress(response)) {
        setRetryAvailable(true);
        setMessage(
          "Activation is still processing. Retry to check the same request.",
        );
        return;
      }

      if (await isHumanAccessMutationRequestCheckFailed(response)) {
        setRetryAvailable(true);
        setMessage(
          "The access check expired or changed. Refreshing… Retry the same activation.",
        );
        router.refresh();
        return;
      }
      if (await isHumanAccessMutationRequestCheckUnavailable(response)) {
        setRetryAvailable(true);
        setMessage(
          "The access check is temporarily unavailable. Retry the same activation.",
        );
        return;
      }
      if (await isHumanAccessMutationAmbiguousFailure(response)) {
        setRetryAvailable(true);
        setMessage(
          "The result could not be confirmed. Retry the same activation.",
        );
        return;
      }
      activationAttempt.current = null;
      setRetryAvailable(false);
      if (response.ok) {
        router.refresh();
        return;
      }
      setMessage("Invitation activation is unavailable. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="dashboard invitation-activation">
      <p className="eyebrow">Foundry invitation</p>
      <h1>Activate your membership</h1>
      <p>
        Cloudflare Access verified <strong>{email}</strong>. Activate the
        matching Foundry membership to enter the dashboard.
      </p>
      <button
        className="copy-button"
        type="button"
        disabled={pending}
        onClick={activate}
      >
        {retryAvailable ? "Retry activation" : "Activate membership"}
      </button>
      <p role="status" aria-live="polite">
        {message}
      </p>
    </main>
  );
}
