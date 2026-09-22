/**
 * The three Newsletter addresses: the campaign list, the writing box for a new
 * email, and one saved email's own screen (#237).
 *
 * Every dashboard link carries the workspace the person is editing, so moving
 * between the list and one email never drops it and sends them back to a
 * different draft.
 *
 * This module holds only strings, so a server page and a client component can
 * both read it.
 */

import { withWorkspace } from "./dashboard-links";

export function campaignListHref(workspace: string | null): string {
  return withWorkspace("/dash/campaigns", workspace);
}

export function newCampaignHref(workspace: string | null): string {
  return withWorkspace("/dash/campaigns/new", workspace);
}

export function campaignHref(
  campaignId: string,
  workspace: string | null,
): string {
  return withWorkspace(
    `/dash/campaigns/${encodeURIComponent(campaignId)}`,
    workspace,
  );
}
