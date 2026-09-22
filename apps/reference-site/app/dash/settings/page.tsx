import { DashboardPageHeader } from "@/components/dashboard-page-header";
import { SettingsTabs, settingsTab } from "@/components/settings-tabs";
import { SettingsUsersBody } from "@/components/settings-users-body";
import {
  loadMutationToken,
  requireAuthorizedSettingsAccess,
} from "@/src/settings-page-context";

export const dynamic = "force-dynamic";

/**
 * Settings' Users tab: who can sign in, and what each of them can do.
 *
 * Settings holds the jobs an owner does rarely, and it is four sections now —
 * Users, Connected agents, Email and Site — each at its own address, so a link
 * can point at one of them and the browser's Back button works between them
 * (#240). This is the first of the four and keeps the `/dash/settings`
 * address, because it is where the sidebar sends the owner.
 *
 * This page only loads the server data; `SettingsUsersBody` (a Client
 * Component) lays it out. The Users table and the retry action under it share
 * one human access mutation, and a hook can only run inside one client
 * component (#150, ADR-0027).
 */
export default async function DashboardSettingsUsersPage() {
  const access = await requireAuthorizedSettingsAccess();
  const mutationToken = await loadMutationToken();
  const members = await access.application.queries.listMembers({
    actor: access.identity,
  });
  const tab = settingsTab("users");

  return (
    <main className="dashboard-main" id="main">
      <DashboardPageHeader title="Settings" description={tab.description} />
      <SettingsTabs current="users" />

      <section aria-labelledby="people">
        <h2 id="people">Users</h2>
        <p>
          An invite or an access change takes effect the next time that person
          loads a page.
        </p>
        <SettingsUsersBody members={members} mutationToken={mutationToken} />
      </section>
    </main>
  );
}
