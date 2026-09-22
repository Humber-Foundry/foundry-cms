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
  readCampaignSendReport,
  refusalCodeIn,
  refusalCodeOf,
  refusalMessage,
  sendCampaignCommand,
  testFailureMessage,
  type CampaignSendReport,
  type SendFlowCommand,
} from "./campaign-operations";
import { useCampaignReadiness } from "./use-campaign-readiness";
import { CampaignEmailPreview } from "./campaign-email-preview";
import { CampaignSendFlow } from "./campaign-send-flow";
import type { EditorMediaContext } from "./change-photo-field";
import { ConnectionStatus } from "./connection-status";
import { EmailComposer } from "./email-composer";

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
  /**
   * Why the last test did not go out, or "" while there is nothing to say.
   * It is drawn on the test step itself, because a refusal belongs beside
   * the control that was pressed, not at the foot of the screen.
   */
  const [testProblem, setTestProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<CampaignSendReport | null>(null);
  const { delivery, senderDetails, senderDetailsMissing } =
    useCampaignReadiness();
  const campaignId = revision.campaignId;

  const loadReport = useCallback(async () => {
    setReport(await readCampaignSendReport(campaignId));
  }, [campaignId]);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  /** Store a change to this email, then read the campaign's state back. */
  async function saveEmail(command: unknown) {
    setBusy(true);
    setMessage("");
    setTestProblem("");
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
    setTestProblem("");
    try {
      const response = await sendCampaignCommand(csrfToken, command);
      const body = (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      // A test's answer goes on the test step. Every other step's answer goes
      // at the foot of the screen, as before.
      const say =
        command.action === "request_test" ? setTestProblem : setMessage;
      if (!response.ok) {
        say(refusalMessage(refusalCodeIn(body)));
      } else if (
        command.action === "request_test" &&
        body?.state !== "accepted"
      ) {
        // The provider answered, but not with a delivery. Say so rather than
        // letting the step look finished.
        say(
          testFailureMessage(
            typeof body?.failureCode === "string" ? body.failureCode : "",
          ),
        );
      }
    } finally {
      await loadReport();
      setBusy(false);
    }
  }

  return (
    <section aria-label="This email">
      <ConnectionStatus kind="senderDetails" readiness={senderDetails} />
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
          {report === null ? (
            <section className="email-preview" aria-label="Email preview">
              <h2>How the email looks</h2>
              <p>Reading this email back from the server…</p>
            </section>
          ) : (
            <>
              <CampaignEmailPreview
                html={report.rendered.html.bytes}
                text={report.rendered.text.bytes}
                contentId={report.rendered.html.fingerprint}
              />
              <CampaignSendFlow
                report={report}
                delivery={delivery}
                role={role}
                busy={busy}
                editBlocked={senderDetailsMissing}
                testProblem={testProblem}
                // The screen's own revision decides whether the review may be
                // shown. The report describes one exact revision, and a review
                // that read a different one would name the wrong subject.
                shownRevisionId={revision.id}
                onCommand={(sendCommand) => {
                  void runStep(sendCommand);
                }}
                onEdit={() => setEditing(true)}
              />
            </>
          )}
        </>
      )}
      {message === "" ? null : <p role="status">{message}</p>}
    </section>
  );
}
