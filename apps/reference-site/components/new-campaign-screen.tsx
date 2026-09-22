"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { parseSerializedRichTextDocument } from "@humber-foundry/site-definition";

import { campaignListHref } from "./campaign-links";
import {
  readCampaignReadiness,
  refusalCodeOf,
  refusalMessage,
  sendCampaignCommand,
  type DeliveryReadiness,
} from "./campaign-operations";
import type { EditorMediaContext } from "./change-photo-field";
import { ConnectionStatus } from "./connection-status";
import { EmailComposer } from "./email-composer";

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
  const [senderDetails, setSenderDetails] = useState<DeliveryReadiness | null>(
    null,
  );

  useEffect(() => {
    let current = true;
    void readCampaignReadiness().then((readiness) => {
      if (current && readiness !== null)
        setSenderDetails(readiness.senderDetails);
    });
    return () => {
      current = false;
    };
  }, []);

  // Without the name and postal address every email would have no compliance
  // footer, so the server refuses to store one. Say that instead of offering a
  // writing box whose save always fails.
  const senderDetailsMissing = senderDetails?.state === "not_configured";

  async function save(command: unknown) {
    setBusy(true);
    setMessage("");
    try {
      const response = await sendCampaignCommand(csrfToken, command);
      if (!response.ok) {
        setMessage(refusalMessage(await refusalCodeOf(response)));
        return;
      }
      setMessage("Email draft saved. Nothing is sent from here.");
      router.push(campaignListHref(workspace));
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="new-campaign-heading">
      <div className="dashboard-section-heading">
        <div>
          <h2 id="new-campaign-heading">Write the email</h2>
          <p>
            It stays a private draft until you send a test and approve it.
          </p>
          <ConnectionStatus kind="senderDetails" readiness={senderDetails} />
        </div>
      </div>
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
