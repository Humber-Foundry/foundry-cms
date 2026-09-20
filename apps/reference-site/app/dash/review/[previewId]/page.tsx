import { notFound } from "next/navigation";

import { PreviewReviewDecision } from "@/components/preview-review-decision";
import {
  PreviewReviewAnswer,
  PreviewReviewSummary,
} from "@/components/preview-review-summary";
import {
  loadMutationToken,
  requireAuthorizedDashboardAccess,
} from "@/src/dashboard-page-context";
import { loadMcpPreviewForHuman } from "@/src/mcp-preview-review-runtime";

export const dynamic = "force-dynamic";
export const metadata = {
  robots: { index: false, follow: false },
  title: "Draft review",
};

/**
 * The screen where a person decides about a draft an app prepared.
 *
 * It only reads. Opening this page records nothing and approves nothing: the
 * decision is a separate POST the person makes after they open the preview.
 */
export default async function McpPreviewReviewPage({
  params,
}: {
  params: Promise<{ previewId: string }>;
}) {
  const access = await requireAuthorizedDashboardAccess();
  const { previewId } = await params;
  const selected = await loadMcpPreviewForHuman({
    previewId,
    siteId: access.membership.siteId,
  });
  if (selected === null) notFound();
  const { review } = selected;
  const mutationToken = await loadMutationToken();

  return (
    <main className="dashboard-main" id="main">
      <PreviewReviewSummary
        agentName={review.agentName}
        preparedAt={review.preparedAt}
        summary={review}
      />

      <section className="panel" aria-labelledby="review-decision">
        <h2 id="review-decision">Your answer</h2>
        {review.decided === null ? (
          <>
            <p>
              Approving does not publish this draft. It lets the app publish
              this exact version, and nothing else.
            </p>
            <PreviewReviewDecision
              previewId={review.previewId}
              previewHref={`/dash/review/${encodeURIComponent(previewId)}/preview`}
              mutationToken={mutationToken}
            />
          </>
        ) : (
          <PreviewReviewAnswer decided={review.decided} />
        )}
      </section>
    </main>
  );
}
