"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import type {
  Campaign,
  CampaignRevision,
  HumanRole,
} from "@humber-foundry/application";
import { parseSerializedRichTextDocument } from "@humber-foundry/site-definition";

import {
  campaignPreviewSrc,
  previewEmailContent,
  readCampaignReadiness,
  readCampaignSendReport,
  refusalCodeOf,
  refusalMessage,
  sendCampaignCommand,
  type CampaignSendReport,
  type DeliveryReadiness,
  type SendFlowCommand,
} from "./campaign-operations";
import { CampaignSendFlow } from "./campaign-send-flow";
import type { EditorMediaContext } from "./change-photo-field";
import { ConnectionStatus } from "./connection-status";
import { EmailComposer } from "./email-composer";
import { HelpTip } from "./help-tip";
import { RichTextRenderer } from "./rich-text-renderer";

/**
 * One saved email, on its own screen (#237): how it looks, the four steps
 * between it and a sent email, and the writing box to change it.
 *
 * Nothing here decides that a step is done. After every command the server's
 * whole report is read again, so what a person sees is what the server holds.
 */
export function CampaignScreen({
  csrfToken,
  role,
  media,
  initialRevision,
}: {
  csrfToken: string;
  /**
   * What this installation's access record says the signed-in person is. The
   * screen uses it only to say whose step a step is; the server decides every
   * command on its own.
   */
  role: HumanRole;
  media: EditorMediaContext;
  initialRevision: CampaignRevision;
}) {
  const router = useRouter();
  const [revision, setRevision] = useState(initialRevision);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<CampaignSendReport | null>(null);
  const [delivery, setDelivery] = useState<DeliveryReadiness | null>(null);
  const [senderDetails, setSenderDetails] = useState<DeliveryReadiness | null>(
    null,
  );
  const campaignId = revision.campaignId;

  const loadReport = useCallback(async () => {
    setReport(await readCampaignSendReport(campaignId));
  }, [campaignId]);

  useEffect(() => {
    let current = true;
    void readCampaignReadiness().then((readiness) => {
      if (current && readiness !== null) {
        setDelivery(readiness.delivery);
        setSenderDetails(readiness.senderDetails);
      }
    });
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  // Every email carries a compliance footer built from the installation's own
  // name and postal address. While they are absent the server refuses to store
  // a revision, so the screen offers no way to change the email.
  const senderDetailsMissing = senderDetails?.state === "not_configured";

  /** Store a change to this email, then read the campaign's state back. */
  async function saveEmail(command: unknown) {
    setBusy(true);
    setMessage("");
    try {
      const response = await sendCampaignCommand(csrfToken, command);
      if (!response.ok) {
        setMessage(refusalMessage(await refusalCodeOf(response)));
        return;
      }
      const body = (await response.json()) as {
        campaign: Campaign;
        revision: CampaignRevision;
      };
      setRevision(body.revision);
      setEditing(false);
      setMessage("Email draft saved. Nothing is sent from here.");
      // An edit makes a new revision, so anything the sending steps knew about
      // the old one is out of date.
      await loadReport();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  /**
   * Run one sending step, then read the campaign's state back.
   *
   * The report is re-read whether the step was accepted or refused, because a
   * refusal can mean the state moved underneath this screen. Nothing on the
   * steps is drawn from the fact that a request returned.
   */
  async function runStep(command: SendFlowCommand) {
    setBusy(true);
    setMessage("");
    try {
      const response = await sendCampaignCommand(csrfToken, command);
      const body = (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      if (!response.ok) {
        const code = typeof body?.error === "string" ? body.error : "";
        setMessage(refusalMessage(code));
      } else if (
        command.action === "request_test" &&
        body?.state !== "accepted"
      ) {
        // The provider answered, but not with a delivery. Say so rather than
        // letting the step look finished.
        const failure =
          typeof body?.failureCode === "string" ? body.failureCode : "";
        setMessage(
          failure === ""
            ? "The test has not been delivered yet."
            : `The test was not delivered. Reason: ${failure}.`,
        );
      }
    } finally {
      await loadReport();
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="campaign-screen-heading">
      <div className="dashboard-section-heading">
        <div>
          <h2 id="campaign-screen-heading">{revision.subject}</h2>
          <p>
            Read it through, send yourself a test, then send it to your
            subscribers.
          </p>
          <ConnectionStatus kind="senderDetails" readiness={senderDetails} />
        </div>
      </div>
      {editing ? (
        <EmailComposer
          key={`${revision.campaignId}:${revision.revisionNumber}`}
          heading="Edit email"
          initialRevision={revision}
          media={media}
          busy={busy}
          saveLabel={busy ? "Saving…" : "Save changes"}
          onSave={(email) => {
            void saveEmail({
              action: "edit",
              campaignId: revision.campaignId,
              expectedVersion: revision.revisionNumber,
              input: {
                ...email,
                emailContent: parseSerializedRichTextDocument(
                  email.emailContent,
                ),
              },
            });
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <section className="email-preview" aria-label="Email preview">
            <h3>How the email looks</h3>
            <div className="email-preview-message rendered-rich-text">
              {revision.headerImage == null ? null : (
                <figure className="campaign-header-image">
                  <img
                    src={campaignPreviewSrc(revision.headerImage.url)}
                    alt={revision.headerImage.alt}
                  />
                </figure>
              )}
              <p className="campaign-preview-line">{revision.previewText}</p>
              <RichTextRenderer
                document={previewEmailContent(revision.emailContent)}
              />
              <p>
                <a href={revision.callToAction.href}>
                  {revision.callToAction.label}
                </a>
              </p>
            </div>
            {report === null ? null : (
              <details>
                <summary>How the email reads, and technical details</summary>
                <pre>{report.rendered.text.bytes}</pre>
                <p>
                  Content ID{" "}
                  <HelpTip label="What's a Content ID?">
                    A code that proves this email's exact content, so support
                    can confirm nothing changed after it was approved.
                  </HelpTip>
                  : <code>{report.rendered.html.fingerprint}</code>
                </p>
              </details>
            )}
          </section>
          {report === null ? null : (
            <CampaignSendFlow
              report={report}
              delivery={delivery}
              role={role}
              busy={busy}
              editBlocked={senderDetailsMissing}
              onCommand={(sendCommand) => {
                void runStep(sendCommand);
              }}
              onEdit={() => setEditing(true)}
            />
          )}
        </>
      )}
      {message === "" ? null : <p role="status">{message}</p>}
    </section>
  );
}
