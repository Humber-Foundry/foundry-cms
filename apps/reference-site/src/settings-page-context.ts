import "server-only";

import { notFound } from "next/navigation";

import { requireAuthorizedDashboardAccess } from "./dashboard-page-context";

/**
 * The access context for a Settings screen.
 *
 * Every Settings tab is Owner-only. Settings is four routes rather than one
 * (#240), so the check lives here and each route calls it, instead of each
 * route repeating the role comparison and risking one of them forgetting it.
 *
 * An Editor gets the same answer as a person asking for an address that does
 * not exist. Settings never tells them it is there and they may not open it.
 */
export async function requireAuthorizedSettingsAccess() {
  const access = await requireAuthorizedDashboardAccess();
  if (access.membership.role !== "owner") {
    notFound();
  }
  return access;
}
