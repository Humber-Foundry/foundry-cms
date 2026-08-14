import {
  audienceDestinations,
  settingsDestination,
  siteDestinations,
  type DashboardDestination,
} from "./dashboard-destinations";

/**
 * The same destinations as the navigation, written out with what each one is
 * for. This is the "where do I go" answer on Overview, so an owner who does not
 * recognise a label can read the sentence under it.
 *
 * These are lists rather than a grid on purpose: the groups hold four, three
 * and one item, and a grid would leave a part-filled last row.
 */
function DestinationList({
  destinations,
  workspaceQuery,
}: {
  destinations: ReadonlyArray<DashboardDestination>;
  workspaceQuery: string;
}) {
  return (
    <ul className="destination-list">
      {destinations.map((destination) => (
        <li key={destination.href}>
          <a href={`${destination.href}${workspaceQuery}`}>
            {destination.label}
          </a>
          <span>{destination.description}</span>
        </li>
      ))}
    </ul>
  );
}

export function OverviewDestinations({
  role,
  workspaceId,
}: {
  role: "owner" | "editor";
  workspaceId?: string;
}) {
  const workspaceQuery =
    workspaceId === undefined
      ? ""
      : `?workspace=${encodeURIComponent(workspaceId)}`;
  // Overview is where the reader already is, so it is not listed again.
  const site = siteDestinations.filter(({ href }) => href !== "/dash");

  return (
    <>
      <section aria-labelledby="overview-site">
        <h2 id="overview-site">Your site</h2>
        <DestinationList
          destinations={site}
          workspaceQuery={workspaceQuery}
        />
      </section>
      <section aria-labelledby="overview-audience">
        <h2 id="overview-audience">Your audience</h2>
        <DestinationList
          destinations={audienceDestinations}
          workspaceQuery={workspaceQuery}
        />
      </section>
      {role === "owner" ? (
        <section aria-labelledby="overview-admin">
          <h2 id="overview-admin">Admin</h2>
          <DestinationList
            destinations={[settingsDestination]}
            workspaceQuery={workspaceQuery}
          />
        </section>
      ) : null}
    </>
  );
}
