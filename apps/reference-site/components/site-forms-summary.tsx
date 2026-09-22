import { DashboardEmptyState } from "@/components/dashboard-empty-state";
import { DashboardList, DashboardListRow } from "@/components/dashboard-list";
import {
  formPlacementAndCountSentence,
  formRowDestination,
  type SiteFormOverviewRow,
} from "@/src/site-forms-overview";

/**
 * "Forms on your site": one row for each form the site declares.
 *
 * Each row answers the owner's three questions — what the form is called,
 * where a visitor finds it, and how many messages it has received. A form
 * that sits on no page says so, because that is the reason an inbox stays
 * empty, and its row opens Pages so the owner can go and place it.
 *
 * It uses the shared dashboard list, so a form reads like every other thing
 * the owner can open. See ADR-0044.
 */
export function SiteFormsSummary({
  forms,
}: {
  forms: ReadonlyArray<SiteFormOverviewRow>;
}) {
  if (forms.length === 0) {
    return (
      <DashboardEmptyState title="No forms yet">
        Your site has no forms, so nobody can write to you. Add a contact form
        block to a page.
      </DashboardEmptyState>
    );
  }
  return (
    <DashboardList label="Forms on your site">
      {forms.map((form) => (
        <DashboardListRow
          key={form.formId}
          href={formRowDestination(form)}
          title={form.name}
          note={formPlacementAndCountSentence(form)}
        />
      ))}
    </DashboardList>
  );
}
