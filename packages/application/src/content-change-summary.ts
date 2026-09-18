import {
  listEditableSiteFields,
  pagePath,
  type EditableSiteField,
  type SiteDefinition,
  type SitePage,
} from "@humber-foundry/site-definition";

/**
 * What happened to one page between the published site and the draft.
 *
 * `created` and `removed` are structural: the page list itself changed.
 * `changed` means the page still exists and at least one of its fields, its
 * name or its web address is different.
 */
export type ContentPageChangeState = "created" | "changed" | "removed";

/**
 * One page the reviewer must look at, named the way the site owner names it.
 *
 * `title` is the page name the owner typed, never the page id. `path` is the
 * web address a visitor uses. `changedFields` holds the field names the owner
 * reads in the editor, and it is empty for a created or a removed page,
 * because the whole page is the change.
 */
export type ContentPageChange = Readonly<{
  pageId: string;
  title: string;
  path: string;
  state: ContentPageChangeState;
  changedFields: ReadonlyArray<string>;
}>;

/**
 * The review summary a person reads before they approve a draft.
 *
 * `changedDocuments` and `designChanges` are short lines of plain words, one
 * per page plus one for the settings that belong to the whole site. They name
 * every changed, created and removed page. `publicEffect` says what a visitor
 * will see after publication, and always ends by saying that reading this
 * review neither approves nor publishes anything.
 */
export type ContentChangeSummary = Readonly<{
  pages: ReadonlyArray<ContentPageChange>;
  changedDocuments: ReadonlyArray<string>;
  designChanges: ReadonlyArray<string>;
  publicEffect: string;
}>;

/** The heading for settings that are not part of one page. */
const wholeSiteTitle = "Whole site";

const reviewDisclaimer =
  "This review does not approve or publish anything.";

function fieldValueKey(field: EditableSiteField) {
  return JSON.stringify(field.value);
}

/** The name the editor shows for one field, with its card heading. */
function fieldName(field: EditableSiteField) {
  return field.section === undefined
    ? field.label
    : `${field.section}: ${field.label}`;
}

function uniqueInOrder(values: ReadonlyArray<string>) {
  return [...new Set(values)];
}

function summaryLine(title: string, entries: ReadonlyArray<string>) {
  return `${title} — ${entries.join(", ")}`;
}

function pageTitle(page: SitePage) {
  return page.title.trim() === "" ? page.slug || "Home page" : page.title;
}

/**
 * Compare the published definition with the draft definition and describe the
 * difference in the words a site owner uses.
 *
 * Every page is covered, not only the home page: a change on any page, a new
 * page and a removed page all appear in the result.
 */
export function createContentChangeSummary(input: {
  base: SiteDefinition;
  draft: SiteDefinition;
}): ContentChangeSummary {
  const baseFields = new Map(
    listEditableSiteFields(input.base).map((field) => [
      field.path,
      fieldValueKey(field),
    ]),
  );
  const basePages = new Map(input.base.pages.map((page) => [page.id, page]));
  const draftPages = new Map(input.draft.pages.map((page) => [page.id, page]));
  const createdPageIds = new Set(
    input.draft.pages
      .filter((page) => !basePages.has(page.id))
      .map((page) => page.id),
  );
  const changedFields = listEditableSiteFields(input.draft).filter(
    (field) =>
      baseFields.get(field.path) !== fieldValueKey(field) &&
      // A new page is reported as one whole page, not as a list of every
      // field it happens to contain.
      (field.pageId === undefined || !createdPageIds.has(field.pageId)),
  );

  const contentFieldsByPage = new Map<string, string[]>();
  const designFieldsByPage = new Map<string, string[]>();
  const wholeSiteContent: string[] = [];
  const wholeSiteDesign: string[] = [];
  for (const field of changedFields) {
    const design = field.group === "Design";
    if (field.pageId === undefined) {
      (design ? wholeSiteDesign : wholeSiteContent).push(fieldName(field));
      continue;
    }
    const byPage = design ? designFieldsByPage : contentFieldsByPage;
    const entries = byPage.get(field.pageId) ?? [];
    entries.push(fieldName(field));
    byPage.set(field.pageId, entries);
  }

  // A page name and a web address are not editable fields yet, so compare
  // them here. Both are visible to a visitor, so both belong in the summary.
  for (const page of input.draft.pages) {
    const before = basePages.get(page.id);
    if (before === undefined) continue;
    const entries = contentFieldsByPage.get(page.id) ?? [];
    if (before.title !== page.title) entries.push("Page name");
    if (before.slug !== page.slug) entries.push("Web address");
    if (entries.length > 0) contentFieldsByPage.set(page.id, entries);
  }

  const pages: ContentPageChange[] = [];
  for (const page of input.draft.pages) {
    const created = createdPageIds.has(page.id);
    const fields = uniqueInOrder([
      ...(contentFieldsByPage.get(page.id) ?? []),
      ...(designFieldsByPage.get(page.id) ?? []),
    ]);
    if (!created && fields.length === 0) continue;
    pages.push({
      pageId: page.id,
      title: pageTitle(page),
      path: pagePath(page),
      state: created ? "created" : "changed",
      changedFields: created ? [] : fields,
    });
  }
  for (const page of input.base.pages) {
    if (draftPages.has(page.id)) continue;
    pages.push({
      pageId: page.id,
      title: pageTitle(page),
      path: pagePath(page),
      state: "removed",
      changedFields: [],
    });
  }

  const changedDocuments: string[] = [];
  const designChanges: string[] = [];
  for (const page of pages) {
    if (page.state === "created") {
      changedDocuments.push(`${page.title} — new page at ${page.path}`);
      continue;
    }
    if (page.state === "removed") {
      changedDocuments.push(`${page.title} — page removed`);
      continue;
    }
    const content = uniqueInOrder(contentFieldsByPage.get(page.pageId) ?? []);
    const design = uniqueInOrder(designFieldsByPage.get(page.pageId) ?? []);
    if (content.length > 0) {
      changedDocuments.push(summaryLine(page.title, content));
    }
    if (design.length > 0) {
      designChanges.push(summaryLine(page.title, design));
    }
  }
  if (wholeSiteContent.length > 0) {
    changedDocuments.push(
      summaryLine(wholeSiteTitle, uniqueInOrder(wholeSiteContent)),
    );
  }
  if (wholeSiteDesign.length > 0) {
    designChanges.push(
      summaryLine(wholeSiteTitle, uniqueInOrder(wholeSiteDesign)),
    );
  }

  const created = pages.filter(({ state }) => state === "created");
  const removed = pages.filter(({ state }) => state === "removed");
  const effects: string[] = [];
  for (const page of created) {
    effects.push(`Visitors get a new page at ${page.path}.`);
  }
  for (const page of removed) {
    effects.push(`The page at ${page.path} is gone.`);
  }
  for (const page of pages) {
    if (page.state !== "changed") continue;
    effects.push(`The page at ${page.path} changes.`);
  }
  if (wholeSiteContent.length > 0 || wholeSiteDesign.length > 0) {
    effects.push("Settings that every page shares change.");
  }
  if (effects.length === 0) {
    effects.push("Nothing on the public site changes.");
  }
  return Object.freeze({
    pages: Object.freeze(pages),
    changedDocuments: Object.freeze(changedDocuments),
    designChanges: Object.freeze(designChanges),
    publicEffect: [...effects, reviewDisclaimer].join(" "),
  });
}
