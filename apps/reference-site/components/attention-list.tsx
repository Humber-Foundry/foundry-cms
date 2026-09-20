/**
 * Overview's "Needs attention" list: one row per thing waiting for the
 * owner, each row the whole clickable link, inside the same card style the
 * section's own empty state uses (see `.empty-state` in dashboard.css).
 * Pulled out of `app/dash/page.tsx` so this exact markup — a plain-word
 * sentence as a full-width, 44px-tall row, with a divider between rows — is
 * covered by its own test, matching the pattern `.copy-button` sizing and
 * `.help-tip` already follow. See issue #222.
 */
export type AttentionListItem = Readonly<{
  key: string;
  href: string;
  label: string;
}>;

export function AttentionList({
  items,
}: {
  items: ReadonlyArray<AttentionListItem>;
}) {
  return (
    <ul className="attention-list">
      {items.map((item) => (
        <li key={item.key}>
          <a href={item.href}>{item.label}</a>
        </li>
      ))}
    </ul>
  );
}
