import type { ContentChangeSummary } from "@humber-foundry/application";
import { contentChangeVisitorEffect } from "@humber-foundry/application";

import { mcpRelativeTime } from "@/src/mcp-connection-display";

const pageStateWords: Readonly<Record<string, string>> = {
  created: "New page",
  changed: "Changed",
  removed: "Removed",
};

export type PreviewReviewDecided = Readonly<{
  decision: "approved" | "changes_requested";
  approvalId: string | null;
  reason: string | null;
  decidedAt: string;
}>;

/**
 * What a person reads before they answer: who prepared the draft, which pages
 * and posts changed, the design changes, and what a visitor will get.
 *
 * It renders only. The controls that record an answer are a separate client
 * component, so nothing on this part of the screen can change server state.
 */
export function PreviewReviewSummary({
  agentName,
  preparedAt,
  summary,
}: {
  agentName: string;
  preparedAt: string;
  summary: ContentChangeSummary;
}) {
  const changeLines = [...summary.changedDocuments, ...summary.designChanges];
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Review this draft</h1>
          <p>
            {agentName} prepared this draft {mcpRelativeTime(preparedAt)}. That
            name is what the app says about itself.
          </p>
        </div>
      </div>

      <section className="panel" aria-labelledby="review-changes">
        <h2 id="review-changes">What changed</h2>
        {summary.pages.length === 0 ? null : (
          <ul className="review-pages">
            {summary.pages.map((page) => (
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
        <p className="review-effect">{contentChangeVisitorEffect(summary)}</p>
      </section>
    </>
  );
}

/**
 * The answer a person already gave about this draft. The reason is text they
 * typed, so it is rendered as text.
 */
export function PreviewReviewAnswer({
  decided,
}: {
  decided: PreviewReviewDecided;
}) {
  if (decided.decision === "approved") {
    return (
      <p>
        You approved this draft {mcpRelativeTime(decided.decidedAt)}. The app
        can publish this exact version now.
      </p>
    );
  }
  return (
    <>
      <p>
        You asked for changes {mcpRelativeTime(decided.decidedAt)}. This is what
        you wrote:
      </p>
      <blockquote className="review-reason">{decided.reason}</blockquote>
    </>
  );
}
