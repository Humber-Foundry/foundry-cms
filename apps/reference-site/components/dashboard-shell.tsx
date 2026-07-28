import type {
  ContentRevision,
  FailedPublicFormDelivery,
  HumanMembership,
  MediaAsset,
  PublicFormDeliveryHealth,
  SuspectedSpamSubmission,
} from "@foundry/application";
import type { SiteDefinition } from "@foundry/site-definition";

import { ContentWorkspaceStarter } from "./content-workspace-starter";
import { DashboardControls } from "./dashboard-controls";
import { MemberAccessControls } from "./member-access-controls";
import { FormOperationsControls } from "./form-operations-controls";
import type { MediaOccurrenceState } from "./media-manager-state";
import { WorkspaceEditors } from "./workspace-editors";

export function DashboardShell({
  definition,
  currentMembership,
  members,
  mutationToken,
  contentRevision,
  contentMutationToken,
  initialPreviewUrl,
  initialContentStale,
  staleRecovery,
  formDeliveryHealth,
  failedFormDeliveries,
  suspectedSpam,
  mediaAssets,
  mediaOccurrences,
  mediaWorkspaceId,
}: {
  definition: SiteDefinition;
  currentMembership: HumanMembership;
  members: ReadonlyArray<HumanMembership>;
  mutationToken: string;
  contentRevision?: ContentRevision;
  contentMutationToken: string;
  initialPreviewUrl?: string;
  initialContentStale?: boolean;
  staleRecovery?: Readonly<{
    id: string;
    sourceWorkspaceId: string;
  }>;
  formDeliveryHealth: PublicFormDeliveryHealth;
  failedFormDeliveries: ReadonlyArray<FailedPublicFormDelivery>;
  suspectedSpam: ReadonlyArray<SuspectedSpamSubmission>;
  mediaAssets: ReadonlyArray<MediaAsset>;
  mediaOccurrences: ReadonlyArray<MediaOccurrenceState>;
  mediaWorkspaceId: string;
}) {
  const activeWorkspaceUrl =
    contentRevision === undefined
      ? "/dash"
      : `/dash?workspace=${encodeURIComponent(contentRevision.workspaceId)}`;
  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <a
          className="wordmark wordmark-dashboard"
          href={activeWorkspaceUrl}
        >
          <span aria-hidden="true">F</span>
          Foundry
        </a>
        <div className="dashboard-header-meta">
          <span className="status-dot">
            {currentMembership.email} · {currentMembership.role}
          </span>
          <a href="/">View public site ↗</a>
        </div>
      </header>
      <div className="dashboard-layout">
        <nav className="dashboard-nav" aria-label="Dashboard">
          <p className="nav-label">Workspace</p>
          <a href={activeWorkspaceUrl} aria-current="page">
            Overview
          </a>
          <span aria-disabled="true">Pages</span>
          <span aria-disabled="true">Design</span>
          <a href="#media-heading">Media</a>
          <p className="nav-label">Operate</p>
          <span aria-disabled="true">Forms</span>
          <span aria-disabled="true">Analytics</span>
        </nav>
        <main className="dashboard-main">
          <div className="notice" role="status">
            <span>Revision editor</span>
            Draft saves are immutable and previews are bound to one exact revision.
          </div>
          <div className="dashboard-title-row">
            <div>
              <p className="eyebrow">Site overview</p>
              <h1>{definition.site.name}</h1>
              <p>{definition.site.description}</p>
            </div>
            <DashboardControls siteId={definition.site.id} />
          </div>
          {contentRevision === undefined ||
          initialPreviewUrl === undefined ? (
            <ContentWorkspaceStarter
              csrfToken={contentMutationToken}
              staleRecovery={staleRecovery}
            />
          ) : (
            <WorkspaceEditors
              csrfToken={contentMutationToken}
              contentRevision={contentRevision}
              initialPreviewUrl={initialPreviewUrl}
              initialContentStale={initialContentStale}
              activeWorkspaceUrl={activeWorkspaceUrl}
              staleRecovery={staleRecovery}
              mediaAssets={mediaAssets}
              mediaOccurrences={mediaOccurrences}
              mediaWorkspaceId={mediaWorkspaceId}
            />
          )}
          <section aria-labelledby="foundation-status">
            <div className="dashboard-section-heading">
              <div>
                <h2 id="foundation-status">Foundation snapshot</h2>
                <p>Facts exposed by the current definition and route boundary.</p>
              </div>
            </div>
            <dl className="status-grid">
              <div>
                <dt>Public renderer</dt>
                <dd>Configured</dd>
                <p>Next.js App Router on the Workers runtime.</p>
              </div>
              <div>
                <dt>Application query</dt>
                <dd>Connected</dd>
                <p>Public and dashboard views use one site scope.</p>
              </div>
              <div>
                <dt>Dashboard mode</dt>
                <dd>Protected</dd>
                <p>Cloudflare Access identity with current D1 membership.</p>
              </div>
            </dl>
            <FormOperationsControls
              csrfToken={mutationToken}
              canReleaseSpam={currentMembership.role === "owner"}
              failedDeliveries={failedFormDeliveries}
              suspectedSpam={suspectedSpam}
            />
          </section>
          <section aria-labelledby="form-delivery-health">
            <div className="dashboard-section-heading">
              <div>
                <h2 id="form-delivery-health">Form delivery health</h2>
                <p>
                  Queue and adapter facts only; submission payloads stay in
                  their authoritative records.
                </p>
              </div>
            </div>
            <dl className="status-grid">
              <div>
                <dt>Oldest queued</dt>
                <dd>
                  {formDeliveryHealth.oldestPendingAgeSeconds === null
                    ? "None"
                    : `${Math.ceil(
                        formDeliveryHealth.oldestPendingAgeSeconds / 60,
                      )} min`}
                </dd>
                <p>
                  {formDeliveryHealth.pending} pending ·{" "}
                  {formDeliveryHealth.processing} processing
                </p>
              </div>
              <div>
                <dt>Failed deliveries</dt>
                <dd>{formDeliveryHealth.failed}</dd>
                <p>{formDeliveryHealth.retries} retry attempts recorded.</p>
              </div>
              <div>
                <dt>Email adapter</dt>
                <dd>{formDeliveryHealth.adapter}</dd>
                <p>Fixed installation-owned staff destination.</p>
              </div>
              <div>
                <dt>Database capacity</dt>
                <dd>{formDeliveryHealth.capacity.state}</dd>
                <p>
                  {formDeliveryHealth.capacity.usedPercent.toFixed(1)}% of the
                  configured limit.
                </p>
              </div>
            </dl>
          </section>
          {currentMembership.role === "owner" ? (
            <section aria-labelledby="human-access">
              <div className="dashboard-section-heading">
                <div>
                  <h2 id="human-access">Human access</h2>
                  <p>
                    Invitations and membership changes apply on the next
                    protected request.
                  </p>
                </div>
              </div>
              <MemberAccessControls
                csrfToken={mutationToken}
                members={members}
              />
            </section>
          ) : null}
          <section className="inventory-section" aria-labelledby="content-inventory">
            <div className="dashboard-section-heading">
              <div>
                <h2 id="content-inventory">Content inventory</h2>
                <p>Stable records in the current published Site Definition.</p>
              </div>
            </div>
            <div className="inventory-table" role="table" aria-label="Content inventory">
              <div className="inventory-row inventory-head" role="row">
                <span role="columnheader">Record</span>
                <span role="columnheader">Stable ID</span>
                <span role="columnheader">State</span>
              </div>
              <div className="inventory-row" role="row">
                <strong role="cell">Home page</strong>
                <code role="cell">{definition.home.id}</code>
                <span role="cell" className="state-label">
                  Published
                </span>
              </div>
              {definition.home.sections.map((section) => (
                <div className="inventory-row" role="row" key={section.id}>
                  <strong role="cell">{section.type}</strong>
                  <code role="cell">{section.id}</code>
                  <span role="cell" className="state-label">
                    Published
                  </span>
                </div>
              ))}
            </div>
          </section>
          <section className="version-card" aria-labelledby="version-heading">
            <div>
              <p className="eyebrow">Version contract</p>
              <h2 id="version-heading">A small, explicit integration boundary.</h2>
              <p>
                Client content composes over a pinned definition and schema
                version. Unknown structure does not silently enter the renderer.
              </p>
            </div>
            <dl>
              <div>
                <dt>Definition</dt>
                <dd>v{definition.definitionVersion}</dd>
              </div>
              <div>
                <dt>Schema</dt>
                <dd>v{definition.schemaVersion}</dd>
              </div>
            </dl>
          </section>
        </main>
      </div>
    </div>
  );
}
