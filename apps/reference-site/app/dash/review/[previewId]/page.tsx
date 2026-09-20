import { notFound } from "next/navigation";

import { contentChangeVisitorEffect } from "@humber-foundry/application";

import { PreviewReviewDecision } from "@/components/preview-review-decision";
import {
  loadMutationToken,
  requireAuthorizedDashboardAccess,
} from "@/src/dashboard-page-context";
import { mcpRelativeTime } from "@/src/mcp-connection-display";
import { loadMcpPreviewForHuman } from "@/src/mcp-preview-review-runtime";

export const dynamic = "force-dynamic";
export const metadata = {
  robots: { index: false, follow: false },
  title: "Draft review",
};

const pageStateWords: Readonly<Record<string, string>> = {
  created: "New page",
  changed: "Changed",
  removed: "Removed",
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
  const changeLines = [...review.changedDocuments, ...review.designChanges];

  return (
    <main className="dashboard-main" id="main">
      <div className="page-heading">
        <h1>Review this draft</h1>
        <p>
          {review.agentName} prepared this draft{" "}
          {mcpRelativeTime(review.preparedAt)}. That name is what the app says
          about itself.
        </p>
      </div>

      <section className="panel" aria-labelledby="review-changes">
        <h2 id="review-changes">What changed</h2>
        {review.pages.length === 0 ? null : (
          <ul className="review-pages">
            {review.pages.map((page) => (
              <li key={page.pageId}>
                <span className="review-page-title">{page.title}</span>{" "}
                <span className="review-page-state">
                  {pageStateWords[page.state] ?? "Changed"} · {page.path}
                </span>
              </li>
            ))}
          </ul>
        )}
        {changeLines.length === 0 ? (
          <p className="empty-state">
            This draft changes nothing a visitor can see.
          </p>
        ) : (
          <ul className="review-changes">
            {changeLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        <p className="review-effect">{contentChangeVisitorEffect(review)}</p>
      </section>

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
        ) : review.decided.decision === "approved" ? (
          <p>
            You approved this draft {mcpRelativeTime(review.decided.decidedAt)}.
            The app can publish this exact version now.
          </p>
        ) : (
          <>
            <p>
              You asked for changes {mcpRelativeTime(review.decided.decidedAt)}.
              This is what you wrote:
            </p>
            <blockquote className="review-reason">
              {review.decided.reason}
            </blockquote>
          </>
        )}
      </section>
    </main>
  );
}
