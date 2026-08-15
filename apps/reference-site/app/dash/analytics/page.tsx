import { AnalyticsDashboard } from "@/components/analytics-dashboard";
import { loadAnalyticsDashboard } from "@/src/analytics-dashboard-runtime";
import { requireAuthorizedDashboardAccess } from "@/src/dashboard-page-context";

export const dynamic = "force-dynamic";

/**
 * Visitors reports aggregate use of the site. It counts no individual person:
 * there are no cookies, no profiles and no stored addresses behind these
 * numbers, and a measurement that is unavailable says so instead of showing a
 * zero.
 */
export default async function DashboardAnalyticsPage() {
  const access = await requireAuthorizedDashboardAccess();
  const analytics = await loadAnalyticsDashboard(access);

  return (
    <main className="dashboard-main" id="main">
      <div className="page-heading">
        <div>
          <h1>Visitors</h1>
          <p>
            How your site is being used, counted without tracking anyone
            personally.
          </p>
        </div>
      </div>
      <AnalyticsDashboard analytics={analytics} />
    </main>
  );
}
