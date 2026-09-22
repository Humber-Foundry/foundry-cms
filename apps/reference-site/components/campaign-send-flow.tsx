"use client";

import { useState } from "react";

import type { HumanRole } from "@humber-foundry/application";

import { ConnectionStatus } from "./connection-status";
import {
  testConfirmed,
  testCoversCurrentEmail,
  type CampaignSendReport,
  type DeliveryReadiness,
  type SendFlowCommand,
} from "./campaign-operations";
import {
  browserTimeZone,
  resolveSendTime,
} from "./schedule-send-time";

/** One step in the list, with what it still needs and what to do about it. */
function SendStep({
  number,
  name,
  state,
  need,
  children,
}: {
  number: number;
  name: string;
  state: "done" | "now" | "later";
  need: string;
  children?: React.ReactNode;
}) {
  return (
    <li className="send-step" data-state={state}>
      <p className="send-step-name">
        {number}. {name}
      </p>
      <p className="send-step-need">{need}</p>
      {children}
    </li>
  );
}

/**
 * The four steps between a written email and a sent one.
 *
 * Every step reads its state from the server's own report. The send steps stay
 * shut until the server says a test of this exact email was delivered and the
 * Owner confirmed it arrived, which is the same rule the server applies to the
 * commands themselves. Nothing here decides that a step is done.
 *
 * Confirming a test and sending are the Owner's steps. That is not a choice
 * made here: the server grants `campaign.test.confirm` and bulk sending to an
 * Owner only, so an Editor is told plainly whose step it is.
 */
export function CampaignSendFlow({
  report,
  delivery,
  role,
  busy,
  editBlocked,
  onCommand,
  onEdit,
}: {
  report: CampaignSendReport;
  delivery: DeliveryReadiness | null;
  role: HumanRole;
  busy: boolean;
  /**
   * True while this installation has no sender details, so no revision can be
   * stored. The server refuses the save either way; the step says so instead
   * of offering a writing box whose save always fails.
   */
  editBlocked: boolean;
  onCommand(command: SendFlowCommand): void;
  onEdit(): void;
}) {
  const [reviewed, setReviewed] = useState(false);
  const [sendAt, setSendAt] = useState("");
  const [timeProblem, setTimeProblem] = useState("");

  const campaignId = report.rendered.campaignId;
  // The one delivered test the server named. Both the confirmation and the
  // approval act on this exact execution, never on a test chosen here.
  const testEvidence = report.testEvidence;
  const notConnected = delivery?.state === "not_configured";
  const tested = testCoversCurrentEmail(report);
  const confirmed = testConfirmed(report);
  const isOwner = role === "owner";
  const { authorization, schedule, sendOperation } = report.bulkState;
  const testRecipientIds =
    report.testRecipients.yours === null
      ? report.testRecipients.ids
      : [report.testRecipients.yours];
  const testStaleAfterEdit = report.testEvidence !== null && !tested;

  function testNeed(): string {
    if (notConnected) {
      return (
        "Email is not connected yet, so no test can go out. Someone with " +
        "access to the site's settings has to finish connecting it."
      );
    }
    if (testStaleAfterEdit) {
      return (
        "You changed the email after the last test, so that test no longer " +
        "counts. Send a new one."
      );
    }
    if (tested) return "A test of this exact email was delivered.";
    if (report.testReadiness.state === "evaluation_only") {
      return "This site is not set up yet to send to a real address.";
    }
    if (report.testReadiness.state === "provider_unhealthy") {
      return "The email provider is not answering right now.";
    }
    // Only a site owner holds a verified test address, so an Editor's test
    // lands in the owner's inbox. Say so rather than promising a copy that
    // never arrives.
    return report.testRecipients.yours === null
      ? "Send a test to the site owner's verified address. They read it."
      : "Send a test to your own verified address, then read it.";
  }

  function confirmNeed(): string {
    if (confirmed) return "You confirmed the test arrived and looked right.";
    if (!isOwner) {
      return (
        "The site owner has to confirm the test arrived. Ask them to check " +
        "their inbox and confirm it."
      );
    }
    if (!tested) return "Send a test first, then read the one that arrives.";
    return "Open the test email in your inbox and read it right through.";
  }

  /**
   * What the send step is on, decided once and used for both the sentence and
   * the controls.
   *
   * A send operation or an active schedule is reported before anything else,
   * because the server still holds it. Editing the email invalidates the
   * approval, and if the screen tested the approval first, the edit would hide
   * the very controls that call a scheduled send off or retry a failed one.
   */
  function sendStage() {
    if (sendOperation !== null) {
      if (sendOperation.state === "sent") return "sent" as const;
      if (sendOperation.state === "ambiguous") return "uncertain" as const;
      return sendOperation.state === "failed" ||
        sendOperation.state === "blocked"
        ? ("failed" as const)
        : ("sending" as const);
    }
    if (schedule !== null) return "scheduled" as const;
    // Whose step it is comes after what is true. An Editor who cannot act
    // still has to read what this campaign is doing.
    if (!isOwner) return "not_yours" as const;
    if (notConnected) return "not_connected" as const;
    if (!confirmed) return "needs_test" as const;
    return authorization === null
      ? ("needs_approval" as const)
      : ("ready" as const);
  }

  const stage = sendStage();

  /**
   * The shared connection-status line: whether email is connected, which
   * settings are missing, and where the setup steps are written down.
   */
  const setupGuideNote =
    notConnected && delivery !== null ? (
      <ConnectionStatus kind="email" readiness={delivery} />
    ) : null;

  const sendNeeds: Readonly<Record<ReturnType<typeof sendStage>, string>> = {
    not_yours:
      "Only the site owner can send an email to subscribers. Ask them to " +
      "finish this step.",
    sent: `Sent to ${sendOperation?.recipientCount ?? 0} people.`,
    failed:
      "The send did not finish. Nobody else will be sent to until you try " +
      "again.",
    sending: "The send is under way.",
    // The provider gave an answer nobody can act on. Sending again could
    // deliver the email twice, so this offers no retry until the provider's
    // own record has been read back.
    uncertain:
      "The email provider's answer was uncertain, so nobody knows yet " +
      "whether this went out. Do not send it again. It is being checked " +
      "against the provider's own record.",
    scheduled: "This email is set to send at the time below.",
    not_connected:
      "Email is not connected yet, so nothing can be sent from here. Step 2 " +
      "says where the steps to connect it are written down.",
    needs_test: "Send a test and confirm it arrived first.",
    needs_approval: "Approve this email, then send it now or pick a time.",
    ready: "Send it now, or pick a time to send it.",
  };

  function sendStepState(): "done" | "now" | "later" {
    if (stage === "sent") return "done";
    return stage === "not_yours" ||
      stage === "needs_test" ||
      stage === "not_connected"
      ? "later"
      : "now";
  }

  function scheduleThisEmail() {
    if (authorization === null) return;
    const resolved = resolveSendTime({
      chosenDateTime: sendAt,
      ianaTimeZone: browserTimeZone(),
      now: new Date(),
    });
    if (resolved.outcome !== "resolved") {
      setTimeProblem(
        resolved.outcome === "already_past"
          ? "That time has already passed. Pick a later one."
          : resolved.outcome === "no_such_time"
            ? "The clocks change that morning, so that time does not exist. Pick another."
            : resolved.outcome === "unknown_time_zone"
              ? "This browser could not read your time zone."
              : "Pick a date and a time.",
      );
      return;
    }
    setTimeProblem("");
    onCommand({
      action: "activate_bulk_schedule",
      campaignId,
      authorizationId: authorization.id,
      resolvedTime: resolved.time,
    });
  }

  return (
    <section className="send-flow" aria-label="Sending steps">
      <h3>Sending steps</h3>
      <ol className="send-flow-steps">
        <SendStep
          number={1}
          name="Write the email"
          state="done"
          need="Saved. You can keep changing it until a test is confirmed."
        >
          <button
            type="button"
            className="copy-button"
            disabled={busy || editBlocked}
            onClick={onEdit}
          >
            Change the email
          </button>
        </SendStep>

        <SendStep
          number={2}
          name={
            report.testRecipients.yours === null
              ? "Send a test to the site owner"
              : "Send a test to yourself"
          }
          state={tested ? "done" : "now"}
          need={testNeed()}
        >
          {tested ? null : (
            <button
              type="button"
              className="copy-button"
              disabled={busy || notConnected || testRecipientIds.length === 0}
              onClick={() =>
                onCommand({
                  action: "request_test",
                  campaignId,
                  testRecipientIds,
                })
              }
            >
              Send a test email
            </button>
          )}
          {setupGuideNote}
          {notConnected || testRecipientIds.length > 0 ? null : (
            <p className="send-step-need">
              There is no verified test address on file, so a test cannot go
              out.
            </p>
          )}
        </SendStep>

        <SendStep
          number={3}
          name="Confirm the test arrived"
          state={confirmed ? "done" : tested && isOwner ? "now" : "later"}
          need={confirmNeed()}
        >
          {confirmed || !tested || !isOwner || testEvidence === null ? null : (
            <div className="send-step-confirm">
              <label className="send-step-check">
                <input
                  type="checkbox"
                  checked={reviewed}
                  disabled={busy}
                  onChange={(event) => setReviewed(event.target.checked)}
                />
                <span>I opened the test email and it reads right.</span>
              </label>
              <button
                type="button"
                className="copy-button"
                disabled={busy || !reviewed}
                onClick={() =>
                  onCommand({
                    action: "confirm_test_receipt",
                    // The server named this exact delivered test. Confirming
                    // any other one would approve content nobody read.
                    executionId: testEvidence.executionId,
                  })
                }
              >
                Confirm the test arrived
              </button>
            </div>
          )}
        </SendStep>

        <SendStep
          number={4}
          name="Send it, or pick a time"
          state={sendStepState()}
          need={sendNeeds[stage]}
        >
          {/*
            An Editor reads the state but is offered no control, because only
            an Owner may send, schedule, cancel or retry. The server refuses
            them either way; showing a button an Editor cannot use would only
            promise something this screen cannot deliver.
          */}
          {!isOwner ? (
            <p className="send-step-reason">
              Only the site owner can start, change or call off a send.
            </p>
          ) : null}
          {sendOperation !== null ? (
            <div className="send-step-outcome">
              {sendOperation.detail === null ? null : (
                <p className="send-step-reason">
                  Reason: {sendOperation.detail}
                </p>
              )}
              <p className="send-step-reason">
                Attempt {sendOperation.attempt}, last changed{" "}
                {sendOperation.updatedAt.replace("T", " at ").slice(0, 19)}.
              </p>
              {stage === "failed" && isOwner ? (
                <button
                  type="button"
                  className="copy-button"
                  // Retrying reaches the provider, so it needs a connected
                  // installation. Calling a send off does not, which is why
                  // the schedule below stays cancellable either way.
                  disabled={busy || notConnected}
                  onClick={() =>
                    onCommand({
                      action: "retry_bulk_send",
                      campaignId,
                      operationId: sendOperation.id,
                    })
                  }
                >
                  Try the send again
                </button>
              ) : null}
            </div>
          ) : schedule !== null ? (
            <div className="send-step-outcome">
              <p className="send-step-need">
                Set to send on {schedule.localDateTime.replace("T", " at ")} (
                {schedule.ianaTimeZone}).
              </p>
              {confirmed ? null : (
                <p className="send-step-reason">
                  You changed the email after this send was set up. Call it off
                  if you do not want the earlier version to go out.
                </p>
              )}
              {isOwner ? (
                <button
                  type="button"
                  className="copy-button"
                  onClick={() =>
                    onCommand({
                      action: "cancel_bulk_schedule",
                      scheduleId: schedule.id,
                    })
                  }
                  disabled={busy}
                >
                  Call this send off
                </button>
              ) : null}
            </div>
          ) : stage === "not_yours" ||
            stage === "needs_test" ||
            stage === "not_connected" ? (
            setupGuideNote
          ) : stage === "needs_approval" ? (
            testEvidence === null ? null : (
              <button
                type="button"
                className="button button-primary"
                disabled={busy || notConnected}
                onClick={() =>
                  onCommand({
                    action: "authorize_bulk",
                    campaignId,
                    testExecutionId: testEvidence.executionId,
                  })
                }
              >
                Approve this email for sending
              </button>
            )
          ) : authorization === null ? null : (
            <div className="send-step-outcome">
              <button
                type="button"
                className="button button-primary"
                disabled={busy || notConnected}
                onClick={() =>
                  onCommand({
                    action: "send_bulk_now",
                    campaignId,
                    authorizationId: authorization.id,
                  })
                }
              >
                Send it now
              </button>
              <div className="send-step-time">
                <label>
                  <span>Or send it at</span>
                  <input
                    type="datetime-local"
                    name="sendAt"
                    value={sendAt}
                    disabled={busy}
                    onChange={(event) => setSendAt(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="copy-button"
                  disabled={busy || sendAt === ""}
                  onClick={scheduleThisEmail}
                >
                  Send it then
                </button>
              </div>
              {timeProblem === "" ? null : (
                <p className="send-step-reason">{timeProblem}</p>
              )}
            </div>
          )}
        </SendStep>
      </ol>
    </section>
  );
}
