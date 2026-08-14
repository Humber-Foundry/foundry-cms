import { FormOperationsControls } from "@/components/form-operations-controls";
import { loadPublicFormOperationsDashboard } from "@/src/public-form-delivery-health-runtime";
import {
  loadMutationToken,
  requireAuthorizedDashboardAccess,
} from "@/src/dashboard-page-context";

export const dynamic = "force-dynamic";

/**
 * Messages covers everything that arrives through the site's forms: what came
 * in, what was held for review, and whether the notification email went out.
 */
export default async function DashboardFormsPage() {
  const access = await requireAuthorizedDashboardAccess();
  const mutationToken = await loadMutationToken();
  const operations = await loadPublicFormOperationsDashboard(access);
  const { health } = operations;

  return (
    <main className="dashboard-main" id="main">
      <div className="page-heading">
        <div>
          <h1>Messages</h1>
          <p>What people sent you through the forms on your site.</p>
        </div>
      </div>

      <FormOperationsControls
        csrfToken={mutationToken}
        canReleaseSpam={access.membership.role === "owner"}
        failedDeliveries={operations.failedDeliveries}
        suspectedSpam={operations.suspectedSpam}
      />

      <section aria-labelledby="delivery-health">
        <h2 id="delivery-health">Delivery</h2>
        <p>
          Whether the emails telling you about new messages are getting
          through. The messages themselves are always kept, even if an email
          fails.
        </p>
        <dl className="fact-list">
          <div>
            <dt>Waiting to send</dt>
            <dd>
              {health.pending === 0 && health.processing === 0
                ? "Nothing waiting"
                : `${health.pending} waiting · ${health.processing} sending`}
            </dd>
          </div>
          <div>
            <dt>Failed to send</dt>
            <dd>
              {health.failed === 0
                ? "None"
                : `${health.failed} failed after ${health.retries} retries`}
            </dd>
          </div>
          <div>
            <dt>Oldest still waiting</dt>
            <dd>
              {health.oldestPendingAgeSeconds === null
                ? "Nothing waiting"
                : `${Math.ceil(health.oldestPendingAgeSeconds / 60)} minutes`}
            </dd>
          </div>
          <div>
            <dt>Storage used</dt>
            <dd>
              {health.capacity.state} · {health.capacity.usedPercent.toFixed(1)}
              % of the limit
            </dd>
          </div>
        </dl>
      </section>
    </main>
  );
}
