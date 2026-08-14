import type { SiteDefinition } from "@humber-foundry/site-definition";

/**
 * The technical record of the installation: which version of the definition and
 * schema is pinned, and the stable identifiers of each published record.
 *
 * This used to sit on the dashboard's front page, where it read as noise to a
 * site owner. It lives in Settings behind a disclosure so it stays available to
 * whoever needs it — support, an agent, or a developer — without being in the
 * way of ordinary editing. It is the one place monospace is right, because
 * these really are identifiers that must be copied exactly.
 */
export function SiteTechnicalDetail({
  definition,
}: {
  definition: SiteDefinition;
}) {
  return (
    <section aria-labelledby="technical-detail">
      <h2 id="technical-detail">Site details</h2>
      <p>
        Reference information about this installation. You do not need any of it
        for ordinary editing.
      </p>
      <dl className="fact-list">
        <div>
          <dt>Site name</dt>
          <dd>{definition.site.name}</dd>
        </div>
        <div>
          <dt>Definition version</dt>
          <dd>
            <code>v{definition.definitionVersion}</code>
          </dd>
        </div>
        <div>
          <dt>Schema version</dt>
          <dd>
            <code>v{definition.schemaVersion}</code>
          </dd>
        </div>
        <div>
          <dt>Editor access</dt>
          <dd>Cloudflare Access with current membership</dd>
        </div>
      </dl>
      <details className="technical-inventory">
        <summary>Published records and their identifiers</summary>
        <table>
          <caption>
            Every record in the published Site Definition, with the identifier
            used to refer to it.
          </caption>
          <thead>
            <tr>
              <th scope="col">Record</th>
              <th scope="col">Identifier</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Home page</th>
              <td>
                <code>{definition.home.id}</code>
              </td>
              <td>Published</td>
            </tr>
            {definition.home.sections.map((section) => (
              <tr key={section.id}>
                <th scope="row">{section.type}</th>
                <td>
                  <code>{section.id}</code>
                </td>
                <td>Published</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
