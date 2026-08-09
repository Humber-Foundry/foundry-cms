import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { createPublicFormReceiptId } from "@humber-foundry/application";

import { FormSubmissionControls } from "@/components/form-submission-controls";
import { loadHumanAccessRequestContext } from "@/src/human-access-runtime";
import { createHumanMutationToken } from "@/src/human-mutation-runtime";
import { createPublicFormOperationsContext } from "@/src/public-form-delivery-health-runtime";

import "../../dashboard.css";

export const dynamic = "force-dynamic";

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

  return (
    <main className="dashboard-main">
      <p><a href="/dash#form-delivery-health">← Form operations</a></p>
      <p className="eyebrow">Audited submission view</p>
      <h1>{submission.formId}</h1>
      <p>
        Receipt {submission.receiptId} · {submission.classification} ·{" "}
        {submission.acceptedAt}
      </p>
      {submission.payloadDeleted ? (
        <p role="status">
          This submission payload was erased. Its receipt and minimal audit
          evidence remain.
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
          csrfToken={await createHumanMutationToken(humanContext.identity)}
          receiptId={submission.receiptId}
          classification={submission.classification}
        />
      ) : null}
    </main>
  );
}
