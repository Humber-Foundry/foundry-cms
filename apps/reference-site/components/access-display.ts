import type { HumanRole, MembershipStatus } from "@humber-foundry/application";

/**
 * The plain word for a user's role, everywhere the dashboard shows one. The
 * underlying value stays the lowercase `"owner"` / `"editor"` the rest of
 * the code already uses; this is display only.
 */
export const roleDisplayLabel: Readonly<Record<HumanRole, string>> = {
  owner: "Owner",
  editor: "Editor",
};

/**
 * The plain word for a user's access status, everywhere the dashboard shows
 * one, matching the capitalized words the status-change buttons already use
 * (Activate, Suspend, Revoke).
 */
export const membershipStatusDisplayLabel: Readonly<
  Record<MembershipStatus, string>
> = {
  active: "Active",
  suspended: "Suspended",
  revoked: "Revoked",
};
