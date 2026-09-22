import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DashboardActionMenu } from "./dashboard-action-menu";
import { DashboardBackLink } from "./dashboard-back-link";
import { DashboardEmptyState } from "./dashboard-empty-state";
import { DashboardList, DashboardListRow } from "./dashboard-list";
import { DashboardPageHeader } from "./dashboard-page-header";
import { DashboardStateLabel } from "./dashboard-state-label";

describe("DashboardPageHeader", () => {
  it("draws the name, the sentence under it, and no action slot by default", () => {
    const markup = renderToStaticMarkup(
      <DashboardPageHeader
        title="Pages"
        description="Edit the words and sections on your site."
      />,
    );

    expect(markup).toContain('class="page-heading"');
    expect(markup).toContain("<h1>Pages</h1>");
    expect(markup).toContain("<p>Edit the words and sections on your site.</p>");
    expect(markup).not.toContain("page-heading-action");
  });

  it("draws one action beside the name when a screen has one", () => {
    const markup = renderToStaticMarkup(
      <DashboardPageHeader
        title="Blog"
        description="Write posts."
        action={
          <button type="button" className="dash-button dash-button-primary">
            New post
          </button>
        }
      />,
    );

    expect(markup).toContain('class="page-heading-action"');
    expect(markup).toContain("New post");
  });
});

describe("DashboardList and DashboardListRow", () => {
  it("names the list for a screen reader and holds its rows", () => {
    const markup = renderToStaticMarkup(
      <DashboardList label="Your pages">
        <DashboardListRow href="/dash/pages?page=home" title="Home" />
      </DashboardList>,
    );

    expect(markup).toContain('aria-label="Your pages"');
    expect(markup).toContain('class="dash-list"');
    expect(markup).toContain('class="dash-row"');
  });

  it("renders the whole row as one link, with the state and actions outside it", () => {
    const markup = renderToStaticMarkup(
      <DashboardListRow
        href="/dash/pages?page=about"
        title="About us"
        note="/about"
        state={
          <DashboardStateLabel tone="live">On your site</DashboardStateLabel>
        }
        actions={
          <DashboardActionMenu
            label="Actions for About us"
            actions={[
              { id: "rename", label: "Rename", onSelect: () => {} },
            ]}
          />
        }
      />,
    );

    // One link, and it carries the title and the supporting line.
    expect(markup.match(/<a /gu)).toHaveLength(1);
    expect(markup).toContain('href="/dash/pages?page=about"');
    expect(markup).toContain('class="dash-row-title"');
    expect(markup).toContain('class="dash-row-note"');
    // The action menu button is not inside the link, so pressing it cannot
    // follow the link.
    const linkEnd = markup.indexOf("</a>");
    expect(markup.indexOf("dash-action-menu-button")).toBeGreaterThan(linkEnd);
    expect(markup.indexOf("dash-row-state")).toBeGreaterThan(linkEnd);
  });

  it("leaves out the supporting line, the state and the actions when a row has none", () => {
    const markup = renderToStaticMarkup(
      <DashboardListRow href="/dash/pages?page=home" title="Home" />,
    );

    expect(markup).not.toContain("dash-row-note");
    expect(markup).not.toContain("dash-row-state");
    expect(markup).not.toContain("dash-row-actions");
  });
});

describe("DashboardStateLabel", () => {
  it("draws the owner's own word, with the colour set by the tone", () => {
    const markup = renderToStaticMarkup(
      <DashboardStateLabel tone="draft">
        Changed since you published
      </DashboardStateLabel>,
    );

    expect(markup).toContain('class="dash-state dash-state-draft"');
    expect(markup).toContain("Changed since you published");
  });

  it("has one class per tone, so colour alone tells the states apart", () => {
    for (const tone of ["live", "draft", "plain", "problem"] as const) {
      const markup = renderToStaticMarkup(
        <DashboardStateLabel tone={tone}>On your site</DashboardStateLabel>,
      );
      expect(markup).toContain(`dash-state-${tone}`);
    }
  });
});

describe("DashboardActionMenu", () => {
  it("draws a closed menu button and no menu at all until it is opened", () => {
    const markup = renderToStaticMarkup(
      <DashboardActionMenu
        label="Actions for About us"
        actions={[
          { id: "rename", label: "Rename", onSelect: () => {} },
          {
            id: "delete",
            label: "Delete",
            tone: "destructive",
            onSelect: () => {},
          },
        ]}
      />,
    );

    expect(markup).toContain('aria-label="Actions for About us"');
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('role="menu"');
    expect(markup).not.toContain("Rename");
  });

  it("draws nothing when the person may take no action on the row", () => {
    const markup = renderToStaticMarkup(
      <DashboardActionMenu label="Actions for About us" actions={[]} />,
    );

    expect(markup).toBe("");
  });
});

describe("DashboardEmptyState", () => {
  it("draws a heading, one sentence, and the control that does the next step", () => {
    const markup = renderToStaticMarkup(
      <DashboardEmptyState
        title="No posts yet"
        action={
          <button type="button" className="dash-button dash-button-primary">
            Write your first post
          </button>
        }
      >
        Write a post to start your blog.
      </DashboardEmptyState>,
    );

    // The dashed box comes from the older `.empty-state`; `.dash-empty`
    // only adds the layout for the heading and the action.
    expect(markup).toContain('class="empty-state dash-empty"');
    expect(markup).toContain("No posts yet");
    expect(markup).toContain("Write a post to start your blog.");
    expect(markup).toContain('class="dash-empty-action"');
  });

  it("leaves the action slot out when there is no next step", () => {
    const markup = renderToStaticMarkup(
      <DashboardEmptyState title="No messages yet">
        Messages people send from your site arrive here.
      </DashboardEmptyState>,
    );

    expect(markup).not.toContain("dash-empty-action");
  });
});

describe("DashboardBackLink", () => {
  it("names the screen it returns to", () => {
    const markup = renderToStaticMarkup(
      <DashboardBackLink href="/dash/settings" label="Back to Settings" />,
    );

    expect(markup).toContain('href="/dash/settings"');
    expect(markup).toContain("Back to Settings");
    // The arrow is decoration; the words carry the meaning.
    expect(markup).toContain('aria-hidden="true"');
  });
});
