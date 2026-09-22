import {
  isSiteDefinition,
  type PageSection,
  type SiteDefinition,
  type SiteHref,
  type SiteMediaOccurrence,
  type SitePage,
} from "./index";
import {
  foundationPageComponentRegistry,
  type PageComponentRegistry,
} from "./page-component-registry";
import {
  createDefaultPageSection,
  remapPageSectionNestedIds,
} from "./component-composition";
import {
  findPageById,
  findPageBySlug,
  homePageSlug,
  pageMediaOccurrenceId,
  pageMediaSlots,
  pageSlugMaxLength,
  reservedPageSlugs,
} from "./pages";
import { findPageHrefReferences, parseSiteHref } from "./site-href";
import { pagePath } from "./seo";
import { designContract } from "./design-tokens";

/**
 * Why a page operation was refused.
 *
 * `code` is the stable word a program reads. `fields` holds the sentence a site
 * owner reads, one per thing that was wrong, keyed by the field it belongs to.
 * Both travel together so the dashboard and the MCP page tools (#161) refuse
 * for the same reason in the same words.
 */
export class PageLifecycleError extends Error {
  readonly code: PageLifecycleErrorCode;
  readonly fields: Readonly<Record<string, string>>;
  /**
   * The links that still point at the page a delete was refused for. Empty for
   * every other refusal. The dashboard names these and offers to open them.
   */
  readonly references: ReadonlyArray<PageLinkReference>;

  constructor(
    code: PageLifecycleErrorCode,
    fields: Readonly<Record<string, string>>,
    references: ReadonlyArray<PageLinkReference> = [],
  ) {
    super(code);
    this.name = "PageLifecycleError";
    this.code = code;
    this.fields = fields;
    this.references = references;
  }
}

export type PageLifecycleErrorCode =
  | "page_not_found"
  | "page_id_taken"
  | "page_id_reserved"
  | "page_slug_refused"
  | "page_title_refused"
  | "page_starting_layout_unknown"
  | "page_is_home"
  | "page_still_linked"
  | "page_section_not_found"
  | "page_section_type_unknown"
  | "page_section_position_invalid"
  | "page_section_variant_unknown"
  | "schema_invalid";

/** One link that still points at a page, named the way its owner reads it. */
export type PageLinkReference = Readonly<{
  location: "navigation" | "page";
  label: string;
  pageId?: string;
}>;

/**
 * The first part of every page id this product mints.
 *
 * The prefix does two jobs. It marks an id as minted rather than hand-written,
 * and it makes the id `home` impossible: `home` has no prefix, so no minted id
 * can ever equal it. Two pages that both claimed the section slot
 * `slot_home_sections` would leave the editor with no single right page to
 * write to. See ADR-0032.
 */
export const mintedPageIdPrefix = "page_";

/**
 * How many hexadecimal characters of the digest a minted page id carries.
 *
 * Twenty characters is eighty bits. A page id is part of every field path of
 * its page, of its section slot id and of its published rich-text file names,
 * so a shorter id keeps those readable, and eighty random bits are far more
 * than a site with a handful of pages ever needs to stay unique.
 */
export const mintedPageIdDigestLength = 20;

/**
 * A page id built from a digest.
 *
 * The caller hashes something that is unique to the one request that mints the
 * page — its idempotency key — so retrying that exact request mints the same
 * id and never a second page. The id is never built from the title or the
 * slug, because both of those change and a page id never does. See ADR-0016.
 */
export function mintedPageId(digestHex: string): string {
  const body = digestHex.slice(0, mintedPageIdDigestLength);
  if (!/^[0-9a-f]+$/u.test(body) || body.length < mintedPageIdDigestLength) {
    throw new TypeError("page_id_digest_invalid");
  }
  return `${mintedPageIdPrefix}${body}`;
}

/** Whether this id has the shape `mintedPageId` produces. */
export function isMintedPageId(value: string): boolean {
  return new RegExp(
    `^${mintedPageIdPrefix}[0-9a-f]{${mintedPageIdDigestLength}}$`,
    "u",
  ).test(value);
}

/**
 * The web address to offer for a page with this name.
 *
 * The owner may change it. This only saves them typing: it lowercases the
 * name, drops accents and punctuation, and joins the remaining words with
 * single hyphens. A name with nothing usable in it, such as a name written
 * entirely in punctuation, falls back to `page`.
 */
export function suggestPageSlug(title: string): string {
  const words = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (words === "") {
    return "page";
  }
  if (words.length <= pageSlugMaxLength) {
    return words;
  }
  const cut = words.slice(0, pageSlugMaxLength);
  const lastHyphen = cut.lastIndexOf("-");
  return (lastHyphen > 0 ? cut.slice(0, lastHyphen) : cut).replace(
    /-+$/u,
    "",
  );
}

const pageSlugShape = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * Why this web address cannot be used, or `null` when it can.
 *
 * `pageId` names the page the address is for, or `null` when the page does not
 * exist yet. This is the one place the page address rules are written as
 * sentences. The editable "Web address" field, the create operation and the
 * rename operation all call it, so an owner reads the same refusal wherever
 * they type the address.
 */
export function pageSlugRefusal(
  definition: SiteDefinition,
  slug: string,
  pageId: string | null,
): string | null {
  const existing = pageId === null ? undefined : findPageById(definition, pageId);
  const isHomePage = existing !== undefined && existing.slug === homePageSlug;
  if (isHomePage && slug !== homePageSlug) {
    return "The home page always sits at the top of the site, so its web address cannot change.";
  }
  if (!isHomePage && slug === homePageSlug) {
    return "Only the home page can sit at the top of the site. Give this page a web address.";
  }
  if (isHomePage) {
    return null;
  }
  if (slug.length > pageSlugMaxLength) {
    return `Use at most ${pageSlugMaxLength} characters.`;
  }
  if (!pageSlugShape.test(slug)) {
    return "Use lowercase letters, numbers and single hyphens, like about-us.";
  }
  if ((reservedPageSlugs as ReadonlyArray<string>).includes(slug)) {
    return `The site already uses /${slug} for something else. Choose another web address.`;
  }
  const taken = findPageBySlug(definition, slug);
  if (taken !== undefined && taken.id !== pageId) {
    return `Another page already sits at /${slug}.`;
  }
  return null;
}

/** Why this page name cannot be used, or `null` when it can. */
export function pageTitleRefusal(title: string): string | null {
  return title.trim() === "" ? "Give this page a name." : null;
}

/**
 * A starting point a new page can be built from.
 *
 * `components` names registered sections only, so a starting point can never
 * put a section on a page that the editor cannot then edit or the renderer
 * cannot draw. `label` and `description` are the words the owner reads.
 */
export type PageStartingLayout = Readonly<{
  id: string;
  label: string;
  description: string;
  components: ReadonlyArray<string>;
}>;

/**
 * The starting points a new page may be built from.
 *
 * Only MCP `foundry.page.create` offers these now. The dashboard has no
 * control that adds a page. See ADR-0041.
 *
 * Three is enough to be useful without becoming a catalogue the owner has to
 * read. Every layout below is built from foundation sections that are already
 * registered, so nothing here needs its own renderer.
 */
export const pageStartingLayouts: ReadonlyArray<PageStartingLayout> =
  Object.freeze([
    Object.freeze({
      id: "blank",
      label: "Blank",
      description: "An empty page. You add the sections yourself.",
      components: Object.freeze([]),
    }),
    Object.freeze({
      id: "introduction",
      label: "Introduction",
      description: "An opening banner, then a place to ask for the next step.",
      components: Object.freeze(["hero", "callToAction"]),
    }),
    Object.freeze({
      id: "what_you_offer",
      label: "What you offer",
      description:
        "An opening banner, a list of what you do, then a place to ask for the next step.",
      components: Object.freeze(["hero", "services", "callToAction"]),
    }),
  ]);

/** The starting point with this id, or `undefined` when there is no such one. */
export function findPageStartingLayout(
  id: string,
): PageStartingLayout | undefined {
  return pageStartingLayouts.find((layout) => layout.id === id);
}

/**
 * Turn a registered component name into the readable part of a section id.
 *
 * `callToAction` becomes `call_to_action`, so a section id reads as words and
 * still matches the identifier shape the schema requires.
 */
function sectionIdWord(componentKey: string): string {
  const word = componentKey
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return word === "" ? "section" : word;
}

/**
 * A section id for one page, built from that page's own id.
 *
 * Every section id starts with the page id, so no two pages ever hold a
 * section with the same id, and therefore no two pages ever hold a field with
 * the same path. `taken` collects the ids already given out, so two sections of
 * the same kind on one page get `..._hero` and `..._hero_2`.
 */
export function freshSectionId(
  pageId: string,
  componentKey: string,
  taken: Set<string>,
): string {
  const base = `${pageId}_${sectionIdWord(componentKey)}`;
  let candidate = base;
  let suffix = 2;
  while (taken.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  taken.add(candidate);
  return candidate;
}

/**
 * The page a `create` builds, before it is added to the definition.
 *
 * The sections are scaffolded one at a time against the page as it stands so
 * far, because a default section may link to a section already on the page.
 * See ADR-0032.
 */
function buildStartingSections(
  definition: SiteDefinition,
  page: SitePage,
  layout: PageStartingLayout,
  registry: PageComponentRegistry,
): ReadonlyArray<PageSection> {
  const taken = new Set<string>();
  let built: SitePage = page;
  for (const componentKey of layout.components) {
    if (!Object.hasOwn(registry.components, componentKey)) {
      throw new PageLifecycleError("page_starting_layout_unknown", {
        startingLayout: "That starting point is not available.",
      });
    }
    const section = createDefaultPageSection(
      componentKey,
      freshSectionId(page.id, componentKey, taken),
      { definition, page: built },
      registry,
    );
    built = { ...built, sections: [...built.sections, section] };
  }
  return built.sections;
}

function emptySeo() {
  return { title: "", description: "", keywords: [], shareImage: null };
}

function requireValid(
  definition: SiteDefinition,
  isDefinition: (value: unknown) => value is SiteDefinition,
): SiteDefinition {
  if (!isDefinition(definition)) {
    throw new PageLifecycleError("schema_invalid", {
      page: "This page does not match the current Site Definition.",
    });
  }
  return definition;
}

function requirePageId(definition: SiteDefinition, pageId: string): void {
  if (pageId === "home" || !isMintedPageId(pageId)) {
    // `home` would collide with the home page's own section slot, and a page
    // id this product did not mint has no guarantee of being free. See
    // ADR-0032.
    throw new PageLifecycleError("page_id_reserved", {
      pageId: "That page identifier cannot be used.",
    });
  }
  if (findPageById(definition, pageId) !== undefined) {
    throw new PageLifecycleError("page_id_taken", {
      pageId: "That page identifier is already in use.",
    });
  }
}

export type CreatePageInput = Readonly<{
  pageId: string;
  title: string;
  slug: string;
  startingLayout: string;
}>;

/**
 * The same definition with one new page added at the end of the page list.
 *
 * The new page is never the home page: `pageSlugRefusal` refuses the root slug
 * for any page that is not already the home page, so creating a page can never
 * make a site with two home pages or move the home page role. Making another
 * page the home page is not part of this operation; see ADR-0033.
 */
export function addPageToDefinition(
  definition: SiteDefinition,
  input: CreatePageInput,
  isDefinition: (value: unknown) => value is SiteDefinition = isSiteDefinition,
  registry: PageComponentRegistry = foundationPageComponentRegistry,
): SiteDefinition {
  requirePageId(definition, input.pageId);
  const titleRefusal = pageTitleRefusal(input.title);
  if (titleRefusal !== null) {
    throw new PageLifecycleError("page_title_refused", { title: titleRefusal });
  }
  const slugRefusal = pageSlugRefusal(definition, input.slug, null);
  if (slugRefusal !== null) {
    throw new PageLifecycleError("page_slug_refused", { slug: slugRefusal });
  }
  const layout = findPageStartingLayout(input.startingLayout);
  if (layout === undefined) {
    throw new PageLifecycleError("page_starting_layout_unknown", {
      startingLayout: "Choose one of the starting points offered.",
    });
  }
  const bare: SitePage = {
    id: input.pageId,
    slug: input.slug,
    title: input.title.trim(),
    seo: emptySeo(),
    sections: [],
  };
  const page: SitePage = {
    ...bare,
    sections: buildStartingSections(definition, bare, layout, registry),
  };
  return requireValid(
    { ...definition, pages: [...definition.pages, page] },
    isDefinition,
  );
}

/**
 * Copy one link from a duplicated section onto the copy's own page.
 *
 * A link to a section of the page being copied must follow the copy, or the
 * button on the new page would send a visitor to the old page. Both
 * stored forms are handled: the bare `#section` shorthand, which always means
 * the home page, and `page:<pageId>#<section>`. Every other link — an email
 * address, the blog, another page — is copied exactly as it was. See ADR-0022.
 */
function copyHref(
  href: SiteHref,
  sourcePage: SitePage,
  newPageId: string,
  sectionIdsBySource: ReadonlyMap<string, string>,
): SiteHref {
  const parsed = parseSiteHref(href);
  if (parsed.kind === "anchor") {
    const copied = sectionIdsBySource.get(parsed.anchor);
    return copied === undefined || sourcePage.slug !== homePageSlug
      ? href
      : (`page:${newPageId}#${copied}` as SiteHref);
  }
  if (parsed.kind === "page" && parsed.pageId === sourcePage.id) {
    if (parsed.anchor === null) {
      return `page:${newPageId}` as SiteHref;
    }
    const copied = sectionIdsBySource.get(parsed.anchor);
    return copied === undefined
      ? (`page:${newPageId}` as SiteHref)
      : (`page:${newPageId}#${copied}` as SiteHref);
  }
  return href;
}

function copySectionLinks(
  section: PageSection,
  sourcePage: SitePage,
  newPageId: string,
  sectionIdsBySource: ReadonlyMap<string, string>,
): PageSection {
  const rewrite = (href: SiteHref) =>
    copyHref(href, sourcePage, newPageId, sectionIdsBySource);
  if (section.type === "hero") {
    return {
      ...section,
      primaryAction: {
        ...section.primaryAction,
        href: rewrite(section.primaryAction.href),
      },
      secondaryAction: {
        ...section.secondaryAction,
        href: rewrite(section.secondaryAction.href),
      },
    };
  }
  if (section.type === "callToAction") {
    return {
      ...section,
      action: { ...section.action, href: rewrite(section.action.href) },
    };
  }
  return section;
}

/**
 * The photos of the copied page, pointing at the same stored pictures.
 *
 * A copy shares its pictures with the page it came from: only the occurrence
 * id changes, because an occurrence id names the page that holds it. Nothing
 * is uploaded again, and deleting either page leaves the other's photo alone.
 * See ADR-0026.
 */
function copyMedia(
  sourcePage: SitePage,
  newPage: SitePage,
): ReadonlyArray<SiteMediaOccurrence> {
  const slotOfOccurrence = new Map(
    pageMediaSlots.map((slot) => [
      pageMediaOccurrenceId(sourcePage, slot),
      slot,
    ]),
  );
  return (sourcePage.media ?? []).flatMap((occurrence) => {
    const slot = slotOfOccurrence.get(occurrence.occurrenceId);
    return slot === undefined
      ? []
      : [
          {
            ...occurrence,
            occurrenceId: pageMediaOccurrenceId(newPage, slot),
          },
        ];
  });
}

export type DuplicatePageInput = Readonly<{
  sourcePageId: string;
  pageId: string;
  title: string;
  slug: string;
}>;

/**
 * The same definition with a copy of one page added after it.
 *
 * The copy gets a new page id and a fresh id for every section it holds, so no
 * two pages ever share a section id or a field path. Its words, its design
 * choices and its photos are the same: a photo is copied by reference, so the
 * two pages show the same stored picture. Its SEO block is copied too, because
 * an owner who duplicates a page expects the copy to read the same.
 */
export function duplicatePageInDefinition(
  definition: SiteDefinition,
  input: DuplicatePageInput,
  isDefinition: (value: unknown) => value is SiteDefinition = isSiteDefinition,
  registry: PageComponentRegistry = foundationPageComponentRegistry,
): SiteDefinition {
  const source = findPageById(definition, input.sourcePageId);
  if (source === undefined) {
    throw new PageLifecycleError("page_not_found", {
      pageId: "That page is not in this draft any more.",
    });
  }
  requirePageId(definition, input.pageId);
  const titleRefusal = pageTitleRefusal(input.title);
  if (titleRefusal !== null) {
    throw new PageLifecycleError("page_title_refused", { title: titleRefusal });
  }
  const slugRefusal = pageSlugRefusal(definition, input.slug, null);
  if (slugRefusal !== null) {
    throw new PageLifecycleError("page_slug_refused", { slug: slugRefusal });
  }
  const taken = new Set<string>();
  const sectionIdsBySource = new Map(
    source.sections.map((section) => [
      section.id,
      freshSectionId(input.pageId, registry.keyFor(section), taken),
    ]),
  );
  const sections = source.sections.map((section) =>
    remapPageSectionNestedIds(
      copySectionLinks(
        { ...section, id: sectionIdsBySource.get(section.id)! },
        source,
        input.pageId,
        sectionIdsBySource,
      ),
    ),
  );
  const copy: SitePage = {
    id: input.pageId,
    slug: input.slug,
    title: input.title.trim(),
    seo: structuredClone(source.seo),
    sections: structuredClone(sections) as PageSection[],
  };
  const media = copyMedia(source, copy);
  const withMedia: SitePage =
    media.length === 0 ? copy : { ...copy, media };
  const sourceIndex = definition.pages.findIndex(
    ({ id }) => id === source.id,
  );
  const pages = [...definition.pages];
  pages.splice(sourceIndex + 1, 0, withMedia);
  return requireValid({ ...definition, pages }, isDefinition);
}

/**
 * The same definition without one page.
 *
 * Two things refuse a delete. The home page cannot go, because every site
 * serves something at the top. A page that a navigation item or a button still
 * links to cannot go either, because the link would be left pointing at
 * nothing; the refusal names each link so the owner can open it and change it
 * first. See ADR-0022.
 *
 * A delete is a draft change like any other. It becomes a new revision, it
 * appears in the review summary, and publishing it is a separate act. An
 * earlier published revision still holds the page.
 */
export function removePageFromDefinition(
  definition: SiteDefinition,
  pageId: string,
  isDefinition: (value: unknown) => value is SiteDefinition = isSiteDefinition,
): SiteDefinition {
  const page = findPageById(definition, pageId);
  if (page === undefined) {
    throw new PageLifecycleError("page_not_found", {
      pageId: "That page is not in this draft any more.",
    });
  }
  if (page.slug === homePageSlug) {
    throw new PageLifecycleError("page_is_home", {
      pageId: "The home page cannot be deleted. Every site needs a home page.",
    });
  }
  const references = findPageHrefReferences(definition, pageId);
  if (references.length > 0) {
    throw new PageLifecycleError(
      "page_still_linked",
      { pageId: pageDeleteBlockedMessage(definition, page, references) },
      references,
    );
  }
  return requireValid(
    {
      ...definition,
      pages: definition.pages.filter(({ id }) => id !== pageId),
    },
    isDefinition,
  );
}

/**
 * What one blocking link is called wherever it is shown.
 *
 * A navigation item is site-wide, so it is named after the Navigation group. A
 * button is named after the page it sits on. This is the only place those
 * names are written: the refusal sentence below and the Pages list both read
 * them from here, so an owner and an MCP caller read the same words. See
 * ADR-0033.
 */
export function pageLinkReferenceName(
  definition: SiteDefinition,
  reference: PageLinkReference,
): string {
  if (reference.location === "navigation") {
    return `Navigation — ${reference.label}`;
  }
  const host =
    reference.pageId === undefined
      ? undefined
      : findPageById(definition, reference.pageId);
  return `${host?.title ?? "Another page"} — ${reference.label}`;
}

/**
 * The sentence shown when a delete is refused because links still point at the
 * page. It names every link, so the owner knows exactly what to change.
 */
export function pageDeleteBlockedMessage(
  definition: SiteDefinition,
  page: SitePage,
  references: ReadonlyArray<PageLinkReference>,
): string {
  const names = references.map((reference) =>
    pageLinkReferenceName(definition, reference),
  );
  return `${page.title} at ${pagePath(page)} is still linked from: ${names.join(", ")}. Change those links first, then delete the page.`;
}

/**
 * One change to the sections of one page.
 *
 * The five operations are the whole vocabulary: put a registered section on
 * the page, take one off, move one, copy one, and choose the section style a
 * section is drawn in. There is no operation that writes a section's words,
 * because a section's words are editable fields and are written the same way
 * every other field is.
 *
 * `position` is a place in the section list as it stands at that step, counted
 * from zero. Operations are carried out in the order they are given, so a
 * caller can add a section and then move it in one request.
 */
export type PageSectionOperation =
  | Readonly<{
      op: "add";
      sectionType: string;
      position: number;
      variant?: string;
    }>
  | Readonly<{ op: "remove"; sectionId: string }>
  | Readonly<{ op: "move"; sectionId: string; position: number }>
  | Readonly<{ op: "duplicate"; sectionId: string }>
  | Readonly<{ op: "set_variant"; sectionId: string; variant: string }>;

/**
 * What one page will hold after a restructure, and which of the sections it
 * already held were given a different section style.
 *
 * They are answered as two separate fields because two different checks write
 * them. The section list is a structure change, which the page composition
 * boundary checks. A style on a section the page already held is a design
 * value, which that section's own editable field checks. See ADR-0035.
 */
export type PageRestructurePlan = Readonly<{
  sections: ReadonlyArray<PageSection>;
  variantChanges: Readonly<Record<string, string>>;
}>;

/**
 * The section styles this kind of section offers. A section the installation
 * registers itself has none, because a style is chosen from the design
 * contract and that contract covers the foundation sections only.
 */
function sectionVariantValues(
  section: PageSection,
): ReadonlyArray<string> {
  return section.type === "registered"
    ? []
    : designContract.variants[section.type].values;
}

function withSectionVariant(
  section: PageSection,
  variant: string,
): PageSection {
  if (!sectionVariantValues(section).includes(variant)) {
    throw new PageLifecycleError("page_section_variant_unknown", {
      variant: "That section style is not offered for this kind of section.",
    });
  }
  return { ...section, variant } as PageSection;
}

/**
 * The sections one page will hold after a list of operations, without writing
 * anything.
 *
 * This is the one place the section operations are written. It builds a new
 * section only through `createDefaultPageSection` and copies one only through
 * `remapPageSectionNestedIds`, so a section this plan produces is the same
 * section the visual editor produces. Whether the result is allowed is decided
 * afterwards by `applyPageComposition`, which is the boundary the dashboard
 * goes through as well; nothing here repeats one of its rules.
 *
 * A new section is scaffolded against the page as it stands before the whole
 * request, which is the page `applyPageComposition` compares the scaffold
 * against.
 */
export function planPageSectionRestructure(
  definition: SiteDefinition,
  page: SitePage,
  operations: ReadonlyArray<PageSectionOperation>,
  registry: PageComponentRegistry = foundationPageComponentRegistry,
): PageRestructurePlan {
  const taken = new Set(page.sections.map(({ id }) => id));
  const sections: PageSection[] = [...page.sections];
  const indexOf = (sectionId: string): number => {
    const index = sections.findIndex(({ id }) => id === sectionId);
    if (index < 0) {
      throw new PageLifecycleError("page_section_not_found", {
        sectionId: "That section is not on this page.",
      });
    }
    return index;
  };
  const requirePosition = (position: number, highest: number): void => {
    if (
      !Number.isSafeInteger(position) ||
      position < 0 ||
      position > highest
    ) {
      throw new PageLifecycleError("page_section_position_invalid", {
        position: `Give a position between 0 and ${Math.max(highest, 0)}.`,
      });
    }
  };
  for (const operation of operations) {
    if (operation.op === "add") {
      if (!Object.hasOwn(registry.components, operation.sectionType)) {
        throw new PageLifecycleError("page_section_type_unknown", {
          sectionType: "That kind of section is not registered for this site.",
        });
      }
      requirePosition(operation.position, sections.length);
      const built = createDefaultPageSection(
        operation.sectionType,
        freshSectionId(page.id, operation.sectionType, taken),
        { definition, page },
        registry,
      );
      sections.splice(
        operation.position,
        0,
        operation.variant === undefined
          ? built
          : withSectionVariant(built, operation.variant),
      );
      continue;
    }
    if (operation.op === "remove") {
      sections.splice(indexOf(operation.sectionId), 1);
      continue;
    }
    if (operation.op === "move") {
      const index = indexOf(operation.sectionId);
      requirePosition(operation.position, sections.length - 1);
      const [moved] = sections.splice(index, 1);
      sections.splice(operation.position, 0, moved!);
      continue;
    }
    if (operation.op === "duplicate") {
      // The copy goes straight after the section it came from, the same way a
      // duplicated page goes straight after the page it came from.
      const index = indexOf(operation.sectionId);
      const source = sections[index]!;
      const copy = remapPageSectionNestedIds({
        ...structuredClone(source),
        id: freshSectionId(page.id, registry.keyFor(source), taken),
      });
      sections.splice(index + 1, 0, copy);
      continue;
    }
    const index = indexOf(operation.sectionId);
    sections[index] = withSectionVariant(
      sections[index]!,
      operation.variant,
    );
  }
  // A variant on a section the page already held is a design value of a record
  // both revisions hold, so it is written as an edit to that section's own
  // field rather than through the composition. A section this request added
  // carries its variant in the composition, because there is nothing to
  // compare it with. See ADR-0035.
  const existingById = new Map(
    page.sections.map((section) => [section.id, section]),
  );
  const variantChanges: Record<string, string> = {};
  for (const section of sections) {
    const existing = existingById.get(section.id);
    if (
      existing === undefined ||
      existing.type === "registered" ||
      section.type === "registered" ||
      existing.variant === section.variant
    ) {
      continue;
    }
    variantChanges[section.id] = section.variant;
  }
  return Object.freeze({
    sections: Object.freeze(sections),
    variantChanges: Object.freeze(variantChanges),
  });
}
