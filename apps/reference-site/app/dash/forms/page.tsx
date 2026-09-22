import {
  createPublicFormReceiptId,
  type PublicFormReceiptId,
} from "@humber-foundry/application";

import { MessageInbox } from "@/components/message-inbox";
import { SiteFormsSummary } from "@/components/site-forms-summary";
import { SpamReviewControls } from "@/components/spam-review-controls";
import { installedPublicForms } from "@/foundry/public-forms";
import { ownerAlertSummary } from "@/src/owner-alert-status";
import {
  loadFormMessageCounts,
  loadPublicFormInbox,
} from "@/src/public-form-messages-runtime";
import {
  loadEditedOrPublishedDefinition,
  loadMutationToken,
  requireAuthorizedDashboardAccess,
} from "@/src/dashboard-page-context";
import { siteFormsOverview } from "@/src/site-forms-overview";

export const dynamic = "force-dynamic";

/**
 * `?older=` carries the receipt of the last message on the page before it.
 * Anything that is not shaped like a receipt is ignored, so a hand-edited
 * address opens the newest page instead of failing.
 */
function readInboxCursor(
  value: string | string[] | undefined,
): PublicFormReceiptId | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/u.test(value)
    ? createPublicFormReceiptId(value)
    : null;
}

function unreadLine(unreadCount: number) {
  if (unreadCount === 0) {
    return "You have read every message.";
  }
  return unreadCount === 1
    ? "1 message you have not read yet."
    : `${unreadCount} messages you have not read yet.`;
}

/**
 * Messages is an inbox. It leads with what people sent, keeps anything held
 * as spam next to it, and says in one line whether the email alerts about new
 * messages are arriving. The alert detail lives in Settings, because a message
 * is saved here whether or not its alert was sent.
 */
export default async function DashboardFormsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireAuthorizedDashboardAccess();
  const mutationToken = await loadMutationToken();
  const { inbox, suspectedSpam, notificationHealth } =
    await loadPublicFormInbox(
      access,
      readInboxCursor((await searchParams).older),
    );
  // The draft, so a form block the owner has just placed is listed here
  // before the site is published. Messages only looks at the site, so it
  // starts no draft and names no workspace: it reads the one this person is
  // already editing, and the published site when there is none.
  const forms = siteFormsOverview(
    await loadEditedOrPublishedDefinition(),
    installedPublicForms,
    await loadFormMessageCounts(access),
  );

  return (
    <main className="dashboard-main" id="main">
      <div className="page-heading">
        <div>
          <h1>Messages</h1>
          <p>What people sent you through the forms on your site.</p>
        </div>
      </div>

      <section aria-labelledby="site-forms">
        <h2 id="site-forms">Forms on your site</h2>
        <p>
          Where people can write to you, and what each form has brought in.
        </p>
        <SiteFormsSummary forms={forms} />
      </section>

      <section aria-labelledby="inbox">
        <h2 id="inbox">Inbox</h2>
        <p>{unreadLine(inbox.unreadCount)}</p>
        <MessageInbox
          messages={inbox.messages}
          olderCursor={inbox.olderCursor}
        />
      </section>

      <section aria-labelledby="spam">
        <h2 id="spam">Spam and messages to check</h2>
        <p>
          These were held because they look like spam. Accepting one moves it
          to your inbox.
        </p>
        <SpamReviewControls
          canAccept={access.membership.role === "owner"}
          csrfToken={mutationToken}
          suspectedSpam={suspectedSpam}
        />
      </section>

      {access.membership.role === "owner" ? (
        <p className="dashboard-note">
          {ownerAlertSummary(notificationHealth)} Every message is saved here
          even when an alert fails.{" "}
          <a href="/dash/settings#email-alerts">See email alerts</a>
        </p>
      ) : null}
    </main>
  );
}
