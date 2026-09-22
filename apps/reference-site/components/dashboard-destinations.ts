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
/**
 * The route of each destination, by the job it does.
 *
 * Another module that links to a screen — Overview's key numbers, for one —
 * reads the route from here instead of writing `/dash/...` again, so a route
 * only ever changes in this file.
 */
export const dashboardRoutes = Object.freeze({
  overview: "/dash",
  pages: "/dash/pages",
  blog: "/dash/blog",
  photos: "/dash/media",
  design: "/dash/design",
  messages: "/dash/forms",
  newsletter: "/dash/campaigns",
  subscribers: "/dash/subscribers",
  visitors: "/dash/analytics",
  settings: "/dash/settings",
} as const);

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
    href: dashboardRoutes.overview,
    label: "Overview",
    description: "What needs your attention today",
  },
  {
    href: dashboardRoutes.pages,
    label: "Pages",
    description: "Edit the words and sections on your site",
  },
  {
    href: dashboardRoutes.blog,
    label: "Blog",
    description: "Write, preview and publish posts",
  },
  {
    href: dashboardRoutes.photos,
    label: "Photos",
    description: "Upload and replace pictures",
  },
  {
    href: dashboardRoutes.design,
    label: "Design",
    description: "Pick a look, then fine-tune fonts, colours and spacing",
  },
];

/** The jobs about the people who read, contact or subscribe to the site. */
export const audienceDestinations: ReadonlyArray<DashboardDestination> = [
  {
    href: dashboardRoutes.messages,
    label: "Messages",
    description: "Read what people sent through your forms",
  },
  {
    href: dashboardRoutes.newsletter,
    label: "Newsletter",
    description: "Write and send emails to your subscribers",
  },
  {
    href: dashboardRoutes.subscribers,
    label: "Subscribers",
    description: "See who is on your list, and export it",
  },
  {
    href: dashboardRoutes.visitors,
    label: "Visitors",
    description: "See how the site is used",
  },
];

/** Access, connected agents and installation detail. Owners only. */
export const settingsDestination: DashboardDestination = {
  href: dashboardRoutes.settings,
  label: "Settings",
  description: "People, connected agents and site details",
  ownerOnly: true,
};
