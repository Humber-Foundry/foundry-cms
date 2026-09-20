import {
  listEditableSiteFields,
  pagePath,
  pageSectionLabel,
  type EditableSiteField,
  type SiteDefinition,
  type SitePage,
} from "@humber-foundry/site-definition";

/**
 * What happened to one page between the published site and the draft.
 *
 * `created` and `removed` are structural: the page list itself changed.
 * `changed` means the page still exists and at least one of its fields, its
 * sections, its name or its web address is different.
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
 * `changedDocuments` and `designChanges` are short lines of plain words: one
 * per page, one for the blog and one for the settings that belong to the whole
 * site. They name every changed, created and removed page. `publicEffect` says
 * what a visitor will see after publication, and always ends by saying that
 * reading this review neither approves nor publishes anything.
 */
export type ContentChangeSummary = Readonly<{
  pages: ReadonlyArray<ContentPageChange>;
  changedDocuments: ReadonlyArray<string>;
  designChanges: ReadonlyArray<string>;
  publicEffect: string;
}>;

/** The heading for settings that belong to no single page. */
const siteSettingsTitle = "Site settings";
/** The heading for the blog, which is a post list and not a page. */
const blogTitle = "Blog";

const reviewDisclaimer = "This review does not approve or publish anything.";

/** One place to collect what changed under one heading. */
type ChangeBucket = { content: string[]; design: string[] };

function fieldValueKey(field: EditableSiteField) {
  return JSON.stringify(field.value);
}

/** The name the editor shows for one field, with its card heading. */
function fieldName(field: EditableSiteField) {
  return field.section === undefined
    ? field.label
    : `${field.section}: ${field.label}`;
}

/**
 * The name for something the draft no longer holds. A removed section takes
 * its card heading, so one gone section reads as one line and not as a list of
 * every field it used to hold.
 */
function removedName(field: EditableSiteField) {
  return `${field.section ?? field.label} removed`;
}

function uniqueInOrder(values: ReadonlyArray<string>) {
  return [...new Set(values)];
}

function summaryLine(title: string, entries: ReadonlyArray<string>) {
  return `${title} — ${entries.join(", ")}`;
}

function pageTitle(page: SitePage) {
  return page.title.trim() === "" ? pagePath(page) : page.title;
}

function bucket(buckets: Map<string, ChangeBucket>, key: string) {
  const found = buckets.get(key);
  if (found !== undefined) return found;
  const created: ChangeBucket = { content: [], design: [] };
  buckets.set(key, created);
  return created;
}

/** The heading one field belongs under: its page, the blog, or the settings. */
function bucketKey(field: EditableSiteField) {
  if (field.group === "Blog") return blogTitle;
  return field.pageId === undefined ? siteSettingsTitle : `page:${field.pageId}`;
}

/**
 * Only the sentences about what a visitor will see.
 *
 * `publicEffect` ends by saying that reading the review neither approves nor
 * publishes anything. That sentence is true on a screen that only shows the
 * change, and wrong on a screen that carries an Approve control, so a screen
 * that can approve reads the visitor sentences through this function.
 */
export function contentChangeVisitorEffect(
  summary: ContentChangeSummary,
): string {
  return summary.publicEffect.endsWith(reviewDisclaimer)
    ? summary.publicEffect
        .slice(0, summary.publicEffect.length - reviewDisclaimer.length)
        .trim()
    : summary.publicEffect;
}

/**
 * Compare the published definition with the draft definition and describe the
 * difference in the words a site owner uses.
 *
 * Every page is covered, not only the home page: a change on any page, a new
 * page, a removed page, a removed section and a reordered page all appear in
 * the result.
 */
export function createContentChangeSummary(input: {
  base: SiteDefinition;
  draft: SiteDefinition;
}): ContentChangeSummary {
  const baseFields = listEditableSiteFields(input.base);
  const draftFields = listEditableSiteFields(input.draft);
  const baseValues = new Map(
    baseFields.map((field) => [field.path, fieldValueKey(field)]),
  );
  const draftPaths = new Set(draftFields.map(({ path }) => path));
  const basePages = new Map(input.base.pages.map((page) => [page.id, page]));
  const draftPages = new Map(input.draft.pages.map((page) => [page.id, page]));
  const createdPageIds = new Set(
    input.draft.pages
      .filter((page) => !basePages.has(page.id))
      .map((page) => page.id),
  );
  const basePosts = input.base.blog?.posts ?? [];
  const draftPosts = input.draft.blog?.posts ?? [];
  const basePostIds = new Set(basePosts.map(({ id }) => id));
  const draftPostIds = new Set(draftPosts.map(({ id }) => id));
  // A blog field's path starts with its post id, and a new post is reported as
  // one whole post, so its fields are left out the way a new page's are.
  const newPostPrefixes = draftPosts
    .filter(({ id }) => !basePostIds.has(id))
    .map(({ id }) => `${id}.`);
  const buckets = new Map<string, ChangeBucket>();

  for (const field of draftFields) {
    // A new page is reported as one whole page, not as a list of every field
    // it happens to contain.
    if (field.pageId !== undefined && createdPageIds.has(field.pageId)) continue;
    if (
      field.group === "Blog" &&
      newPostPrefixes.some((prefix) => field.path.startsWith(prefix))
    ) {
      continue;
    }
    if (baseValues.get(field.path) === fieldValueKey(field)) continue;
    const entries = bucket(buckets, bucketKey(field));
    (field.group === "Design" ? entries.design : entries.content).push(
      fieldName(field),
    );
  }

  // A page name, a web address, a page's sections and the order of the pages
  // are not editable fields, so compare them here. A visitor sees them all.
  //
  // `goneSections` holds the card heading of every section the draft dropped,
  // so the loop over the base fields below can leave those fields out: one
  // gone section reads as one line, not as a list of every field it held.
  const goneSections = new Map<string, Set<string>>();
  for (const page of input.draft.pages) {
    const before = basePages.get(page.id);
    if (before === undefined) continue;
    const entries = bucket(buckets, `page:${page.id}`);
    if (before.title !== page.title) entries.content.push("Page name");
    if (before.slug !== page.slug) entries.content.push("Web address");
    const draftSectionIds = new Set(page.sections.map(({ id }) => id));
    const beforeSectionIds = new Set(before.sections.map(({ id }) => id));
    const gone = new Set<string>();
    for (const section of before.sections) {
      if (draftSectionIds.has(section.id)) continue;
      entries.content.push(`${pageSectionLabel(section)} removed`);
      gone.add(pageSectionLabel(section));
    }
    goneSections.set(page.id, gone);
    for (const section of page.sections) {
      if (beforeSectionIds.has(section.id)) continue;
      entries.content.push(`${pageSectionLabel(section)} added`);
    }
    // Order is only a change when the same sections are in a new order. A
    // section that came or went is already one line of its own.
    const keptBefore = before.sections
      .filter(({ id }) => draftSectionIds.has(id))
      .map(({ id }) => id);
    const keptDraft = page.sections
      .filter(({ id }) => beforeSectionIds.has(id))
      .map(({ id }) => id);
    if (keptBefore.join(",") !== keptDraft.join(",")) {
      entries.design.push("Section order");
    }
  }
  const basePageOrder = input.base.pages
    .filter(({ id }) => draftPages.has(id))
    .map(({ id }) => id);
  const draftPageOrder = input.draft.pages
    .filter(({ id }) => basePages.has(id))
    .map(({ id }) => id);
  if (basePageOrder.join(",") !== draftPageOrder.join(",")) {
    bucket(buckets, siteSettingsTitle).content.push("Page order");
  }

  for (const field of baseFields) {
    if (draftPaths.has(field.path)) continue;
    // A removed page is reported as one whole page for the same reason.
    if (field.pageId !== undefined && !draftPages.has(field.pageId)) continue;
    // A design choice cannot disappear on its own: it goes when its section
    // goes, and that section's own line already says so.
    if (field.group === "Design") continue;
    if (
      field.pageId !== undefined &&
      field.section !== undefined &&
      goneSections.get(field.pageId)?.has(field.section) === true
    ) {
      continue;
    }
    // A blog post that is gone is reported as one post below.
    if (field.group === "Blog") continue;
    // Something gone is a content change, even when it held a design choice.
    bucket(buckets, bucketKey(field)).content.push(removedName(field));
  }

  // Posts are not pages, so they get their own lines under the blog heading.
  for (const post of basePosts) {
    if (draftPostIds.has(post.id)) continue;
    bucket(buckets, blogTitle).content.push(`${post.title} removed`);
  }
  for (const post of draftPosts) {
    if (basePostIds.has(post.id)) continue;
    bucket(buckets, blogTitle).content.push(`${post.title} added`);
  }

  const pages: ContentPageChange[] = [];
  for (const page of input.draft.pages) {
    const created = createdPageIds.has(page.id);
    const entries = buckets.get(`page:${page.id}`) ?? {
      content: [],
      design: [],
    };
    const fields = uniqueInOrder([...entries.content, ...entries.design]);
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
  /** Turn one heading's collected entries into at most two summary lines. */
  function emit(title: string, key: string) {
    const entries = buckets.get(key);
    if (entries === undefined) return;
    if (entries.content.length > 0) {
      changedDocuments.push(summaryLine(title, uniqueInOrder(entries.content)));
    }
    if (entries.design.length > 0) {
      designChanges.push(summaryLine(title, uniqueInOrder(entries.design)));
    }
  }
  for (const page of pages) {
    if (page.state === "created") {
      changedDocuments.push(`${page.title} — new page at ${page.path}`);
      continue;
    }
    if (page.state === "removed") {
      changedDocuments.push(`${page.title} — page removed`);
      continue;
    }
    emit(page.title, `page:${page.pageId}`);
  }
  emit(blogTitle, blogTitle);
  emit(siteSettingsTitle, siteSettingsTitle);

  const effects: string[] = [];
  for (const page of pages) {
    if (page.state !== "created") continue;
    effects.push(`Visitors get a new page at ${page.path}.`);
  }
  for (const page of pages) {
    if (page.state !== "removed") continue;
    effects.push(`The page at ${page.path} is gone.`);
  }
  for (const page of pages) {
    if (page.state !== "changed") continue;
    effects.push(`The page at ${page.path} changes.`);
  }
  if (buckets.has(blogTitle)) {
    effects.push("The blog changes.");
  }
  if (buckets.has(siteSettingsTitle)) {
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
