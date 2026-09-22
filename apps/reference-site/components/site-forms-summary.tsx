import {
  formMessageCountSentence,
  formNotPlacedNotice,
  type SiteFormOverviewRow,
} from "@/src/site-forms-overview";

/**
 * "Forms on your site": one row for each form the site declares.
 *
 * Each row answers the owner's three questions — what the form is called,
 * where a visitor finds it, and how many messages it has brought in. A form
 * that sits on no page says so, because that is the reason an inbox stays
 * empty. See ADR-0044.
 */
export function SiteFormsSummary({
  forms,
}: {
  forms: ReadonlyArray<SiteFormOverviewRow>;
}) {
  if (forms.length === 0) {
    return (
      <p className="empty-state">
        Your site has no forms yet, so nobody can send you a message.
      </p>
    );
  }
  return (
    <ul className="site-form-list">
      {forms.map((form) => {
        const notPlaced = formNotPlacedNotice(form);
        return (
          <li className="site-form-item" key={form.formId}>
            <span className="site-form-name">{form.name}</span>
            <span className="site-form-detail">
              {notPlaced === null ? (
                <>
                  Appears on{" "}
                  {form.placements.map((placement, index) => (
                    <span key={placement.pagePath}>
                      {index === 0 ? null : ", "}
                      <a
                        className="site-form-page"
                        href={placement.pagePath}
                      >
                        {placement.pageTitle}
                      </a>{" "}
                      ({placement.pagePath})
                    </span>
                  ))}
                  . {formMessageCountSentence(form)}
                </>
              ) : (
                <>
                  {notPlaced} {formMessageCountSentence(form)}
                </>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
