import { headers } from "next/headers";
import { notFound } from "next/navigation";

import {
  createPublicFormReceiptId,
  isPublicFormReplyAddress,
  summarizePublicFormSubmission,
} from "@humber-foundry/application";

import { FormSubmissionControls } from "@/components/form-submission-controls";
import { formatDashboardMoment } from "@/src/dashboard-time";
import { loadHumanAccessRequestContext } from "@/src/human-access-runtime";
import { createHumanMutationToken } from "@/src/human-mutation-runtime";
import {
  createPublicFormOperationsContext,
  installedPublicFormInboxPlan,
} from "@/src/public-form-messages-runtime";

import "../../dashboard.css";

export const dynamic = "force-dynamic";

/**
 * One message, in full. Opening this page is what marks the message read.
 */
export default async function FormSubmissionPage({
  params,
}: {
  params: Promise<{ receiptId: string }>;
}) {
  const humanContext = await loadHumanAccessRequestContext(await headers());
  if (humanContext.state !== "authorized") notFound();
  const application = await createPublicFormOperationsContext(humanContext);
  const submission = await application.queries
    .submission({
      actor: humanContext.identity,
      receiptId: createPublicFormReceiptId((await params).receiptId),
    })
    .catch(() => notFound());
  const summary = summarizePublicFormSubmission({
    plan: installedPublicFormInboxPlan,
    formId: submission.formId,
    fields: submission.fields,
  });
  // A held message is not in the inbox yet, so there is nothing to reply to
  // until someone accepts it. An erased message has no address left to use.
  const replyAddress =
    summary.replyAddress !== null &&
    isPublicFormReplyAddress(summary.replyAddress) &&
    !submission.payloadDeleted &&
    submission.classification === "accepted"
      ? summary.replyAddress
      : null;

  return (
    <main className="dashboard-main">
      <p>
        <a href="/dash/forms">← Back to Messages</a>
      </p>
      <h1>{summary.senderName ?? "Message"}</h1>
      <p>
        {submission.formId} form ·{" "}
        {formatDashboardMoment(submission.acceptedAt)} · receipt{" "}
        {submission.receiptId}
      </p>
      {submission.classification === "suspected_spam" ? (
        <p role="status">
          This one was held because it looks like spam. It is not in your
          inbox.
        </p>
      ) : null}
      {replyAddress === null ? null : (
        <p>
          <a className="copy-button" href={`mailto:${replyAddress}`}>
            Reply by email
          </a>
        </p>
      )}
      {submission.payloadDeleted ? (
        <p role="status">
          The contents of this message were erased. Its receipt and the record
          of what happened to it remain.
        </p>
      ) : (
        <dl className="status-grid">
          {Object.entries(submission.fields).map(([field, value]) => (
            <div key={field}>
              <dt>{field}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {humanContext.membership.role === "owner" &&
      !submission.payloadDeleted ? (
        <FormSubmissionControls
          classification={submission.classification}
          csrfToken={await createHumanMutationToken(humanContext.identity)}
          receiptId={submission.receiptId}
        />
      ) : null}
    </main>
  );
}
