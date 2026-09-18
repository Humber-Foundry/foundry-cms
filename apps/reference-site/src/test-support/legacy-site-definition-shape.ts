import {
  homePage,
  type SiteDefinition,
} from "@humber-foundry/site-definition";

/**
 * The same definition in the shape it was stored in before 1.7.0: one `home`
 * object instead of a `pages` collection, with no slug and no title, because
 * neither field existed then.
 *
 * A fixture that claims a schema version older than 1.7.0 must use that
 * version's shape, or it never exercises the page-collection projection step.
 */
// The return type is `any` on purpose. The result is a definition in an older
// schema shape, which no current type describes, and every caller feeds it to
// a reader that takes an unknown stored value.
export function withLegacyHomeShape(definition: SiteDefinition): any {
  const copy = structuredClone(definition);
  const { pages: _pages, ...rest } = copy as unknown as Record<string, any>;
  const { slug: _slug, title: _title, ...home } = homePage(copy);
  return { ...rest, home };
}
