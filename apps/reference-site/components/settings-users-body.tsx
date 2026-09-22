"use client";

import type { HumanMembership } from "@humber-foundry/application";

import {
  AccessSyncRetryControls,
  MemberAccessPanel,
  useHumanAccessMutation,
} from "./member-access-controls";

/**
 * Settings' Users tab below its heading.
 *
 * This is one client component, not a server page rendering separate client
 * islands, because the user table and the retry action under it share one
 * human access mutation (`useHumanAccessMutation`): retrying means replaying
 * the exact same in-flight request, so the two pieces of UI that show it
 * cannot each own a separate copy of that state. A function cannot cross from
 * a Server Component into a Client Component as a prop, so the page loads the
 * server data and passes it here as plain values (#150, ADR-0027).
 */
export function SettingsUsersBody({
  members,
  mutationToken,
}: {
  members: ReadonlyArray<HumanMembership>;
  mutationToken: string;
}) {
  const mutation = useHumanAccessMutation({ csrfToken: mutationToken });

  return (
    <>
      <MemberAccessPanel members={members} mutation={mutation} />
      <AccessSyncRetryControls mutation={mutation} />
    </>
  );
}
