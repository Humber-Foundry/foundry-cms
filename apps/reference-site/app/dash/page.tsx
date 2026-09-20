import { formatLocalScheduleTime } from "@/components/schedule-time-format";
import { ContentDraftRecovery } from "@/components/content-draft-recovery";
import { loadMessagesAttention } from "@/src/public-form-messages-runtime";
import {
  loadPreviewsWaitingForReview,
  unnamedConnectedApp,
} from "@/src/mcp-preview-review-runtime";
import { loadBlogPostOperationalSummaries } from "@/src/blog-post-operations-runtime";
import { blogScheduleRequestAgentNames } from "@/src/blog-schedule-request-runtime";
import {
  loadDashboardWorkspace,
  loadMutationToken,
  loadPublishedDefinition,
  preservedRevisionOf,
  readWorkspaceSearchParams,
  recoveryReasonOf,
  requireAuthorizedDashboardAccess,
} from "@/src/dashboard-page-context";
import { loadHumanAccessEnvironment } from "@/src/human-access-environment";
import { mcpScheduleRequestAgentName } from "@/src/mcp-schedule-request-agent";
import { loadPendingCampaignScheduleRequests } from "@/src/campaign-schedule-request-runtime";
import type { BlogPostId } from "@humber-foundry/site-definition";

export const dynamic = "force-dynamic";

type PendingBlogScheduleRequest = Readonly<{
  postId: BlogPostId;
  postTitle: string;
  agentName: string;
  requestedTime: string;
}>;

/**
 * Every post with a schedule request nobody has answered yet, newest post
 * first, with the plain words Overview shows: the post's own title, the
 * time the app asked for in its own words (see `formatLocalScheduleTime`),
 * and the app's name. See ADR-0036 and issue #219.
 *
 * Returns an empty list instead of throwing when blog-post operations are
 * not configured, so a missing schedule backend never blocks Overview.
 */
async function loadPendingBlogScheduleRequests(
  siteId: string,
  posts: ReadonlyArray<Readonly<{ id: BlogPostId; title: string }>>,
): Promise<ReadonlyArray<PendingBlogScheduleRequest>> {
  try {
    const environment = await loadHumanAccessEnvironment();
    const summaries = await loadBlogPostOperationalSummaries(
      environment,
      siteId,
      posts.map((post) => post.id),
    );
    const pendingProposalsByPostId = new Map(
      [...summaries.entries()]
        .filter(([, summary]) => summary.pendingScheduleProposal !== null)
        .map(([postId, summary]) => [
          postId,
          summary.pendingScheduleProposal!,
        ]),
    );
    // Overview only ever shows a request an app made — see issue #219 — so
    // `blogScheduleRequestAgentNames` already leaves out a proposal a
    // person made directly, rather than relabelling it as an app's.
    const agentNames = await blogScheduleRequestAgentNames(
      environment,
      pendingProposalsByPostId,
    );
    const postsById = new Map(posts.map((post) => [post.id, post]));
    return [...pendingProposalsByPostId.entries()]
      .flatMap(([postId, proposal]) => {
        const agentName = agentNames.get(postId);
        const post = postsById.get(postId);
        if (agentName === undefined || post === undefined) return [];
        return [{
          postId,
          postTitle: post.title,
          agentName,
          requestedTime: formatLocalScheduleTime(
            proposal.localDateTime,
            proposal.ianaTimeZone,
          ),
        }];
      })
      .sort((left, right) =>
        pendingProposalsByPostId.get(right.postId)!.createdAt.localeCompare(
          pendingProposalsByPostId.get(left.postId)!.createdAt,
        )
      );
  } catch {
    return [];
  }
}

type PendingCampaignScheduleRequest = Readonly<{
  campaignId: string;
  subject: string;
  agentName: string;
  requestedTime: string;
}>;

/**
 * Every campaign with a send-time request nobody has answered yet, newest
 * first, in the plain words Overview shows: the email's own subject, the time
 * the app asked for, and the app's name. See ADR-0039.
 *
 * Returns an empty list instead of throwing when the newsletter is not
 * configured, so a missing newsletter setting never blocks Overview.
 */
async function loadPendingCampaignRequests(): Promise<
  ReadonlyArray<PendingCampaignScheduleRequest>
> {
  try {
    const environment = await loadHumanAccessEnvironment();
    const requests = await loadPendingCampaignScheduleRequests();
    const named = await Promise.all(
      requests.map(async (request) => {
        const agentName = await mcpScheduleRequestAgentName(
          environment,
          request.createdBy,
        );
        return agentName === null
          ? null
          : {
              campaignId: request.campaignId,
              subject: request.subject,
              agentName,
              requestedTime: formatLocalScheduleTime(
                request.localDateTime,
                request.ianaTimeZone,
              ),
            };
      }),
    );
    return named.filter(
      (request): request is PendingCampaignScheduleRequest =>
        request !== null,
    );
  } catch {
    return [];
  }
}

/**
 * Overview answers one question: what should I do next? It shows the state of
 * the draft, anything waiting for attention, and a way into each job. The
 * editing surfaces themselves live on their own destinations.
 */
export default async function DashboardOverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireAuthorizedDashboardAccess();
  const definition = await loadPublishedDefinition();
  const { workspace, staleRecovery } =
    await readWorkspaceSearchParams(searchParams);
  const dashboardWorkspace = await loadDashboardWorkspace(
    workspace,
    "/dash",
    staleRecovery,
  );
  const mutationToken = await loadMutationToken();
  const messages = await loadMessagesAttention(access);
  const previewsToReview = await loadPreviewsWaitingForReview({
    siteId: access.membership.siteId,
  });

  // The draft workspace always exists, so Overview reports the draft. It only
  // offers a fresh start when this draft can no longer accept changes.
  const { contentRevision } = dashboardWorkspace;
  const needsFreshWorkspace =
    dashboardWorkspace.schemaRecovery !== undefined ||
    dashboardWorkspace.contentStale;
  const pendingScheduleRequests = needsFreshWorkspace
    ? []
    : await loadPendingBlogScheduleRequests(
        access.membership.siteId,
        contentRevision.definition.blog.posts,
      );
  const pendingCampaignRequests = await loadPendingCampaignRequests();

  return (
    <main className="dashboard-main" id="main">
      <div className="page-heading">
        <div>
          <h1>{definition.site.name}</h1>
          <p>{definition.site.description}</p>
        </div>
      </div>

      {needsFreshWorkspace ? (
        <ContentDraftRecovery
          csrfToken={mutationToken}
          staleRecovery={staleRecovery}
          preservedRevision={preservedRevisionOf(contentRevision)}
          durableRecoveryEdits={dashboardWorkspace.schemaRecovery}
          reason={recoveryReasonOf(dashboardWorkspace)}
        />
      ) : (
        <section className="panel" aria-labelledby="draft-state">
          <h2 id="draft-state">Your draft</h2>
          {contentRevision.revision === 0 ? (
            <p>
              Your draft is ready and matches your live site. Open Pages to
              start changing it. Nothing you change reaches the live site until
              you publish.
            </p>
          ) : (
            <p>
              You have unpublished changes. Open Pages to keep editing, or
              publish when you are happy with the preview.
            </p>
          )}
          <p className="panel-actions">
            <a
              className="button button-primary"
              href={`/dash/pages?workspace=${encodeURIComponent(
                dashboardWorkspace.workspaceId,
              )}`}
            >
              {contentRevision.revision === 0
                ? "Start editing"
                : "Continue editing"}
            </a>
          </p>
        </section>
      )}

      <section aria-labelledby="attention">
        <h2 id="attention">Needs attention</h2>
        {messages.unreadCount === 0 &&
        messages.heldForReview === 0 &&
        previewsToReview.length === 0 &&
        pendingScheduleRequests.length === 0 &&
        pendingCampaignRequests.length === 0 ? (
          <p className="empty-state">
            Nothing is waiting for you. New messages, anything held as spam,
            and drafts or schedule requests an app made for you appear here.
          </p>
        ) : (
          <ul className="attention-list">
            {previewsToReview.map((preview) => (
              <li key={preview.previewId}>
                <a
                  href={`/dash/review/${encodeURIComponent(preview.previewId)}`}
                >
                  {preview.agentName === unnamedConnectedApp
                    ? "A draft waiting for your review"
                    : `A draft from ${preview.agentName} waiting for your review`}
                </a>
              </li>
            ))}
            {pendingScheduleRequests.map((request) => (
              <li key={request.postId}>
                <a
                  href={`/dash/blog?workspace=${encodeURIComponent(
                    dashboardWorkspace.workspaceId,
                  )}#blog-post-${encodeURIComponent(request.postId)}`}
                >
                  {request.agentName} asked to publish "{request.postTitle}"
                  {" "}at {request.requestedTime}
                </a>
              </li>
            ))}
            {pendingCampaignRequests.map((request) => (
              <li key={request.campaignId}>
                <a
                  href={`/dash/campaigns#campaign-${encodeURIComponent(
                    request.campaignId,
                  )}`}
                >
                  {request.agentName} asked to send "{request.subject}"
                  {" "}at {request.requestedTime}
                </a>
              </li>
            ))}
            {messages.unreadCount > 0 ? (
              <li>
                <a href="/dash/forms">
                  {messages.unreadCount} message
                  {messages.unreadCount === 1 ? "" : "s"} you have not read
                </a>
              </li>
            ) : null}
            {messages.heldForReview > 0 ? (
              <li>
                <a href="/dash/forms">
                  {messages.heldForReview} message
                  {messages.heldForReview === 1 ? "" : "s"} held as spam
                </a>
              </li>
            ) : null}
          </ul>
        )}
      </section>
    </main>
  );
}
