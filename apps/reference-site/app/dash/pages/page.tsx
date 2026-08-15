import { DashboardWorkspacePage } from "@/components/dashboard-workspace-page";

export const dynamic = "force-dynamic";

/**
 * Pages is the main editing job: change the words on the site, and add, move,
 * duplicate or remove sections on the rendered page.
 */
export default async function DashboardPagesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <DashboardWorkspacePage
      destination="pages"
      searchParams={searchParams}
    />
  );
}
