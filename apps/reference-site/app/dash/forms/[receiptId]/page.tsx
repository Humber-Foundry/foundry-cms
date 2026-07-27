import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { createPublicFormReceiptId } from "@foundry/application";

import { loadHumanAccessRequestContext } from "@/src/human-access-runtime";
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
      <dl className="status-grid">
        {Object.entries(submission.fields).map(([field, value]) => (
          <div key={field}>
            <dt>{field}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </main>
  );
}
