/**
 * The dashboard's destinations, in one place so the navigation and the Overview
 * list can never disagree.
 *
 * This is a plain module rather than part of the client navigation component:
 * server components read these arrays directly, and a "use client" module would
 * hand them a client reference instead of the data.
 *
 * Every entry is a real route. The navigation never shows a name the owner
 * cannot open.
 */
export type DashboardDestination = Readonly<{
  href: string;
  label: string;
  /** What the owner does here, shown on Overview and as the link's title. */
  description: string;
  ownerOnly?: boolean;
}>;

/** The jobs that change what a visitor sees. */
export const siteDestinations: ReadonlyArray<DashboardDestination> = [
  {
    href: "/dash",
    label: "Overview",
    description: "What needs your attention today",
  },
  {
    href: "/dash/pages",
    label: "Pages",
    description: "Edit the words and sections on your site",
  },
  {
    href: "/dash/blog",
    label: "Blog",
    description: "Write, preview and publish posts",
  },
  {
    href: "/dash/media",
    label: "Photos",
    description: "Upload and replace pictures",
  },
  {
    href: "/dash/design",
    label: "Design",
    description: "Pick a look, then fine-tune fonts, colours and spacing",
  },
];

/** The jobs about the people who read, contact or subscribe to the site. */
export const audienceDestinations: ReadonlyArray<DashboardDestination> = [
  {
    href: "/dash/forms",
    label: "Messages",
    description: "Read what people sent through your forms",
  },
  {
    href: "/dash/campaigns",
    label: "Newsletter",
    description: "Write and send campaigns",
  },
  {
    href: "/dash/analytics",
    label: "Visitors",
    description: "See how the site is used",
  },
];

/** Access, connected agents and installation detail. Owners only. */
export const settingsDestination: DashboardDestination = {
  href: "/dash/settings",
  label: "Settings",
  description: "People, connected agents and site details",
  ownerOnly: true,
};
