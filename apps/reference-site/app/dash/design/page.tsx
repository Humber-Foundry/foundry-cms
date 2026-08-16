import { DashboardWorkspacePage } from "@/components/dashboard-workspace-page";

export const dynamic = "force-dynamic";

/**
 * Design holds the preset looks and the controlled design tokens behind them —
 * heading font, body text font, accent colour, page tone, space between
 * sections and content width. They edit the same revision as Pages, through
 * the same save and publish controls.
 */
export default async function DashboardDesignPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <DashboardWorkspacePage
      destination="design"
      searchParams={searchParams}
    />
  );
}
