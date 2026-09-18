"use client";

import { usePathname, useSearchParams } from "next/navigation";

import {
  audienceDestinations,
  settingsDestination,
  siteDestinations,
  type DashboardDestination,
} from "./dashboard-destinations";

/**
 * A marker string that must appear in the dashboard's own client bundle and
 * must never appear in a public route's bundle. `scripts/verify-public-bundle.mjs`
 * checks both. This navigation renders on every dashboard page, so it is
 * the marker's home.
 */
export const DASHBOARD_PRIVATE_BUNDLE_MARKER =
  "FOUNDRY_DASHBOARD_PRIVATE_CLIENT_BOUNDARY";

function isCurrent(pathname: string, href: string): boolean {
  return href === "/dash" ? pathname === "/dash" : pathname.startsWith(href);
}

function DestinationLink({
  destination,
  pathname,
  workspaceQuery,
}: {
  destination: DashboardDestination;
  pathname: string;
  workspaceQuery: string;
}) {
  const current = isCurrent(pathname, destination.href);
  return (
    <a
      href={`${destination.href}${workspaceQuery}`}
      aria-current={current ? "page" : undefined}
      title={destination.description}
    >
      {destination.label}
    </a>
  );
}

/**
 * The dashboard's one navigation: a column beside the content on a wide screen,
 * and a scrollable row above it on a phone. Every destination stays reachable
 * from every other one, and the selected workspace travels with the links so
 * moving between destinations never loses the draft being edited.
 */
export function DashboardNav({ role }: { role: "owner" | "editor" }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // The draft — and any recovery in progress — travels with the links.
  const carried = new URLSearchParams();
  for (const key of ["workspace", "recovery", "recoverFrom"]) {
    const value = searchParams.get(key);
    if (value !== null) carried.set(key, value);
  }
  const workspaceQuery =
    carried.size === 0 ? "" : `?${carried.toString()}`;
  const visible = (destinations: ReadonlyArray<DashboardDestination>) =>
    destinations.filter(
      (destination) => !destination.ownerOnly || role === "owner",
    );

  const groups: ReadonlyArray<
    Readonly<{ name: string; destinations: ReadonlyArray<DashboardDestination> }>
  > = [
    { name: "Your site", destinations: visible(siteDestinations) },
    { name: "Your audience", destinations: visible(audienceDestinations) },
    { name: "Admin", destinations: visible([settingsDestination]) },
  ];

  return (
    <nav
      className="dashboard-nav"
      aria-label="Dashboard sections"
      data-private-boundary={DASHBOARD_PRIVATE_BUNDLE_MARKER}
    >
      {groups
        .filter(({ destinations }) => destinations.length > 0)
        .map(({ name, destinations }) => (
          <div className="dashboard-nav-group" key={name}>
            <h2>{name}</h2>
            {destinations.map((destination) => (
              <DestinationLink
                key={destination.href}
                destination={destination}
                pathname={pathname}
                workspaceQuery={workspaceQuery}
              />
            ))}
          </div>
        ))}
    </nav>
  );
}
