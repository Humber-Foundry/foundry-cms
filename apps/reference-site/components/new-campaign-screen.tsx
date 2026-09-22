"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { parseSerializedRichTextDocument } from "@humber-foundry/site-definition";

import { campaignListHref } from "./campaign-links";
import {
  refusalCodeOf,
  refusalMessage,
  sendCampaignCommand,
} from "./campaign-operations";
import type { EditorMediaContext } from "./change-photo-field";
import { ConnectionStatus } from "./connection-status";
import { EmailComposer } from "./email-composer";
import { useCampaignReadiness } from "./use-campaign-readiness";

/**
 * The writing box for one new email, on its own screen (#237).
 *
 * Saving stores a private draft and nothing else. The person is then taken
 * back to the campaign list, where the new email is one row, so the next steps
 * — the preview, the test and the send — are in front of them.
 */
export function NewCampaignScreen({
  csrfToken,
  workspace,
  media,
}: {
  csrfToken: string;
  workspace: string | null;
  media: EditorMediaContext;
}) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  // Without the sender details the server refuses to store a revision, so the
  // screen says that instead of offering a writing box whose save must fail.
  const { senderDetails, senderDetailsMissing } = useCampaignReadiness();

  async function save(command: unknown) {
    setBusy(true);
    setMessage("");
    try {
      const response = await sendCampaignCommand(csrfToken, command);
      if (!response.ok) {
        setMessage(refusalMessage(await refusalCodeOf(response)));
        return;
      }
      // The list is a server-rendered screen, and the browser still holds the
      // copy it read before this email existed. Drop that copy first, then go
      // back to the list, or the owner returns to a list without the email
      // they just wrote.
      router.refresh();
      router.push(campaignListHref(workspace));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="New email">
      <ConnectionStatus kind="senderDetails" readiness={senderDetails} />
      {senderDetailsMissing ? null : (
        <EmailComposer
          heading="New email"
          media={media}
          busy={busy}
          saveLabel={busy ? "Saving…" : "Save email"}
          onSave={(email) => {
            void save({
              action: "create_standalone",
              input: {
                ...email,
                emailContent: parseSerializedRichTextDocument(
                  email.emailContent,
                ),
              },
            });
          }}
          onCancel={() => router.push(campaignListHref(workspace))}
        />
      )}
      {message === "" ? null : <p role="status">{message}</p>}
    </section>
  );
}
