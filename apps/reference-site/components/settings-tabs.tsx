/**
 * Settings' four sections: Users, Connected agents, Email and Site.
 *
 * Each section is its own route, so a link can point at one section and the
 * browser's own Back button works between them. This is a plain module rather
 * than a client component: every Settings route is a Server Component and
 * passes the section it is showing, so nothing here has to read the address
 * bar in the browser.
 *
 * The word "agent" is used here on purpose. Everywhere else the dashboard says
 * "app"; in Settings and on the Connect an agent screen the owner's own word
 * for the thing they connect is "agent" (CONTEXT.md).
 */
export type SettingsSection = "users" | "agents" | "email" | "site";

export type SettingsTab = Readonly<{
  section: SettingsSection;
  href: string;
  label: string;
  /** One sentence under the page name while this section is open. */
  description: string;
}>;

export const settingsTabs: ReadonlyArray<SettingsTab> = Object.freeze([
  {
    section: "users",
    href: "/dash/settings",
    label: "Users",
    description: "Who can sign in, and what each of them can do.",
  },
  {
    section: "agents",
    href: "/dash/settings/agents",
    label: "Connected agents",
    description: "The AI agents that may work on this site, and what you let them do.",
  },
  {
    section: "email",
    href: "/dash/settings/email",
    label: "Email",
    description:
      "Whether email can be sent, what every email says at the bottom, and alerts about new messages.",
  },
  {
    section: "site",
    href: "/dash/settings/site",
    label: "Site",
    description: "Publishing, room left for messages, and reference details about this site.",
  },
]);

export function settingsTab(section: SettingsSection): SettingsTab {
  const found = settingsTabs.find((tab) => tab.section === section);
  // Every caller passes a section from the union above, so this cannot be
  // reached. It keeps the return type free of `undefined` for the callers.
  if (found === undefined) throw new Error("unknown_settings_section");
  return found;
}

export function SettingsTabs({ current }: { current: SettingsSection }) {
  return (
    <nav className="dash-tabs" aria-label="Settings sections">
      {settingsTabs.map((tab) => (
        <a
          key={tab.section}
          className="dash-tab"
          href={tab.href}
          aria-current={tab.section === current ? "page" : undefined}
        >
          {tab.label}
        </a>
      ))}
    </nav>
  );
}
