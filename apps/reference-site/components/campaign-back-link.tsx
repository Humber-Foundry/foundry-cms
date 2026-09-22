import { campaignListHref } from "./campaign-links";

/**
 * The way back to the campaign list from a screen that opens from it (#237).
 *
 * The new email screen and one saved email's screen both carry it, in the same
 * words, so neither is a dead end. #227 replaces this with the dashboard's own
 * shared back link.
 */
export function CampaignBackLink({ workspace }: { workspace: string | null }) {
  return (
    <p>
      <a className="dashboard-back-link" href={campaignListHref(workspace)}>
        ← Back to Newsletter
      </a>
    </p>
  );
}
