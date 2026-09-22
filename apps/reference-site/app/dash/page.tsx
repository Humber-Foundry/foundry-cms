import { campaignHref } from "@/components/campaign-links";
import { formatLocalScheduleTime } from "@/components/schedule-time-format";
import { AttentionList } from "@/components/attention-list";
import { ContentDraftRecovery } from "@/components/content-draft-recovery";
import { dashboardRoutes } from "@/components/dashboard-destinations";
import { SiteRenderer } from "@/components/site-renderer";
import { SitePreviewFrame } from "@/components/site-preview-frame";
import {
  OverviewActivity,
  OverviewNumbers,
  SiteCard,
} from "@/components/site-overview";
import { loadMessagesAttention } from "@/src/public-form-messages-runtime";
import {
  loadPreviewsWaitingForReview,
  unnamedConnectedApp,
} from "@/src/mcp-preview-review-runtime";
import { loadBlogPostOperationalSummaries } from "@/src/blog-post-operations-runtime";
import { blogScheduleRequestAgentNames } from "@/src/blog-schedule-request-runtime";
import { loadAnalyticsOverview } from "@/src/analytics-dashboard-runtime";
import type { ReportingPeriodDays } from "@/src/analytics-reporting-period";
import { loadContentPublicationQueries } from "@/src/content-publication-runtime";
import { formatDashboardMoment } from "@/src/dashboard-time";
import {
  loadDashboardWorkspace,
  loadMutationToken,
  loadPublishedDefinition,
  preservedRevisionOf,
  readWorkspaceSearchParams,
  recoveryReasonOf,
  requireAuthorizedDashboardAccess,
} from "@/src/dashboard-page-context";
import { loadOverviewCampaignScheduleRequests } from "@/src/campaign-schedule-request-runtime";
import { loadHumanAccessEnvironment } from "@/src/human-access-environment";
import {
  messagesOverviewNumber,
  pagesOverviewNumber,
  publicSiteAddress,
  recentSiteActivity,
  subscribersOverviewNumber,
  visitsOverviewNumber,
} from "@/src/overview-summary";
import { loadSubscriberStateCounts } from "@/src/subscriber-ledger-runtime";
import { homePage, type BlogPostId } from "@humber-foundry/site-definition";

export const dynamic = "force-dynamic";

/**
 * How far back the key numbers look. Issue #228 asks for the last 30 days,
 * which is also one of the two periods the Visitors screen offers, so the
 * number's link opens Visitors on the same period.
 */
const overviewPeriodDays: ReportingPeriodDays = 30;

/**
 * The width the picture of the home page is laid out at before it is shrunk
 * to fit the card. A desktop width, so the picture shows the site the way a
 * reader on a computer sees it. `/dash/design` lays its own preview out the
 * same way.
 */
const sitePreviewLayoutWidth = 1560;

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

/**
 * Reads one store for one card, and turns a failure into `null` so the rest
 * of Overview still renders. The failure is written to the server log under
 * `name`, the same way `loadAnalyticsOverview` reports its own, so an
 * operator sees the fault the owner is only told about in plain words.
 */
async function readOrReport<Result>(
  name: string,
  read: () => Promise<Result>,
): Promise<Result | null> {
  try {
    return await read();
  } catch (error) {
    console.error(name, {
      failure: error instanceof Error ? error.name : "unknown",
    });
    return null;
  }
}

/**
 * Overview is the home of the dashboard. It answers three questions in one
 * screen: what does my site look like and how do I change it, how is it
 * doing, and what is waiting for me.
 *
 * Every number here comes from the screen that owns it, and links back to
 * that screen. A source that cannot answer produces a sentence saying so,
 * never a zero and never a figure worked out from something else.
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
    dashboardRoutes.overview,
    staleRecovery,
  );
  const mutationToken = await loadMutationToken();
  // A store that cannot answer must not take the whole screen down with it.
  // Each of these reads its own source; a failure means the card beside it
  // says which source is missing.
  const messages = await readOrReport("overview_messages_unavailable", () =>
    loadMessagesAttention(access),
  );
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
  // Every campaign with a send-time request nobody has answered yet, each
  // named by the app that asked. See ADR-0039.
  const pendingCampaignRequests =
    await loadOverviewCampaignScheduleRequests();

  // Three stores that know nothing about each other, so they are read at the
  // same time rather than one after another.
  //
  // `publications` is `null` when the publish records could not be read, and
  // an empty list when nothing has been published yet. Recent activity says
  // something different for each, so the two answers are kept apart.
  const [analyticsOverview, subscriberCounts, publications] = await Promise.all([
    loadAnalyticsOverview(access, { periodDays: overviewPeriodDays }),
    readOrReport("overview_subscriber_counts_unavailable", () =>
      loadSubscriberStateCounts(access),
    ),
    readOrReport("overview_publications_unavailable", async () =>
      (await loadContentPublicationQueries()).listHistory(),
    ),
  ]);

  const workspaceQuery = `workspace=${encodeURIComponent(
    dashboardWorkspace.workspaceId,
  )}`;
  // Two different home pages, on purpose. The picture shows the home page as
  // it is published, because that is what a reader sees today. "Edit site"
  // opens the draft's own home page, because that is what the owner changes.
  // They carry the same id unless the draft replaced the page.
  const publishedHomePage = homePage(definition);
  const draftHomePage = homePage(contentRevision.definition);
  // `resolveEditorPage` reads the page the editor opens from `?page=`.
  const editHref = `${dashboardRoutes.pages}?${workspaceQuery}&page=${encodeURIComponent(
    draftHomePage.id,
  )}`;
  const publicAddress = publicSiteAddress(definition.site.canonicalOrigin);
  // 0 here only decides whether to draw a message row. When the store could
  // not answer, `messages` is null and the section says so instead of
  // reporting that nothing is waiting.
  const unreadMessages = messages?.unreadCount ?? 0;
  const heldMessages = messages?.heldForReview ?? 0;
  const nothingIsWaiting =
    messages !== null &&
    unreadMessages === 0 &&
    heldMessages === 0 &&
    previewsToReview.length === 0 &&
    pendingScheduleRequests.length === 0 &&
    pendingCampaignRequests.length === 0;
  const attentionItemCount =
    unreadMessages +
    heldMessages +
    previewsToReview.length +
    pendingScheduleRequests.length +
    pendingCampaignRequests.length;

  return (
    <main className="dashboard-main" id="main">
      <SiteCard
        siteName={definition.site.name}
        // The dashboard and the live site are served by the same app, so the
        // site's own root is the address that always opens.
        publicHref="/"
        publicAddress={publicAddress}
        editHref={editHref}
        hasDraftChanges={contentRevision.revision > 0}
        preview={
          <SitePreviewFrame layoutWidth={sitePreviewLayoutWidth}>
            <SiteRenderer
              definition={definition}
              page={publishedHomePage}
              editingSurface
            />
          </SitePreviewFrame>
        }
      />

      {needsFreshWorkspace ? (
        <ContentDraftRecovery
          csrfToken={mutationToken}
          staleRecovery={staleRecovery}
          preservedRevision={preservedRevisionOf(contentRevision)}
          durableRecoveryEdits={dashboardWorkspace.schemaRecovery}
          reason={recoveryReasonOf(dashboardWorkspace)}
        />
      ) : null}

      <OverviewNumbers
        sample={analyticsOverview?.sample ?? false}
        numbers={[
          visitsOverviewNumber(
            analyticsOverview?.overview ?? null,
            overviewPeriodDays,
          ),
          messagesOverviewNumber(messages === null ? null : unreadMessages),
          subscribersOverviewNumber(subscriberCounts?.confirmed ?? null),
          pagesOverviewNumber(definition.pages.length),
        ]}
      />

      <section aria-labelledby="attention">
        <h2 id="attention">Needs attention</h2>
        {messages === null ? (
          <p className="empty-state">
            Your message store could not be read just now, so any new
            messages and anything held as spam are missing from this list.
            Open Messages to try again.
          </p>
        ) : null}
        {nothingIsWaiting ? (
          <p className="empty-state">
            Nothing is waiting for you. New messages, anything held as spam,
            and drafts or schedule requests an app made for you appear here.
          </p>
        ) : attentionItemCount === 0 ? null : (
          <AttentionList
            items={[
              ...previewsToReview.map((preview) => ({
                key: `preview-${preview.previewId}`,
                href: `/dash/review/${encodeURIComponent(preview.previewId)}`,
                label:
                  preview.agentName === unnamedConnectedApp
                    ? "A draft waiting for your review"
                    : `A draft from ${preview.agentName} waiting for your review`,
              })),
              ...pendingScheduleRequests.map((request) => ({
                key: `schedule-${request.postId}`,
                href: `${dashboardRoutes.blog}?${workspaceQuery}#blog-post-${encodeURIComponent(
                  request.postId,
                )}`,
                label: `${request.agentName} asked to publish "${request.postTitle}" at ${request.requestedTime}`,
              })),
              ...pendingCampaignRequests.map((request) => ({
                key: `campaign-schedule-${request.campaignId}`,
                // One email has its own screen since #237, so the item opens
                // that email rather than an anchor on the list.
                href: campaignHref(
                  request.campaignId,
                  dashboardWorkspace.workspaceId,
                ),
                label: `${request.agentName} asked to send "${request.subject}" at ${formatLocalScheduleTime(
                  request.localDateTime,
                  request.ianaTimeZone,
                )}`,
              })),
              ...(unreadMessages > 0
                ? [
                    {
                      key: "messages-unread",
                      href: dashboardRoutes.messages,
                      label: `${unreadMessages} message${
                        unreadMessages === 1 ? "" : "s"
                      } you have not read`,
                    },
                  ]
                : []),
              ...(heldMessages > 0
                ? [
                    {
                      key: "messages-held",
                      href: dashboardRoutes.messages,
                      label: `${heldMessages} message${
                        heldMessages === 1 ? "" : "s"
                      } held as spam`,
                    },
                  ]
                : []),
            ]}
          />
        )}
      </section>

      <OverviewActivity
        items={
          publications === null
            ? null
            : recentSiteActivity({
                publications,
                draftSavedAt: contentRevision.createdAt,
                draftRevision: contentRevision.revision,
                editorHref: editHref,
                formatMoment: formatDashboardMoment,
              })
        }
      />
    </main>
  );
}
