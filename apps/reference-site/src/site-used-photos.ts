import "server-only";

import {
  type SiteDefinition,
  type SitePage,
} from "@humber-foundry/site-definition";
import {
  mediaAssetIdFromPublishedPath,
  siteDefinitionMediaAssetIds,
} from "@humber-foundry/site-definition";

import { placeNameFor } from "@/components/media-places";
import { installedPageComponentRegistry } from "@/foundry/page-components";

/**
 * A photo the site displays that is not a library asset — a built-in image an
 * installation ships, or an external image address. It shows in the gallery as
 * a read-only "on the page" tile, so "all your photos" includes every photo the
 * site actually shows, not only the ones uploaded to the library.
 */
export type SiteImageTile = Readonly<{ src: string; name: string }>;

// Every page contributes, not only the home page, so "all your photos"
// includes a photo placed on any page. See ADR-0026.
function imageAddressesOf(definition: SiteDefinition): ReadonlySet<string> {
  const found = new Set<string>();
  for (const page of definition.pages) {
    for (const section of page.sections) {
      if (section.type !== "registered") continue;
      const registration =
        installedPageComponentRegistry.components[section.component];
      if (registration === undefined) continue;
      for (const [key, field] of Object.entries(registration.fields)) {
        if (field.control !== "image") continue;
        const value = (section.props as Record<string, unknown>)[key];
        if (typeof value === "string" && value.trim() !== "") found.add(value);
      }
    }
  }
  return found;
}

/** The file name an owner reads for one image address. */
function imageName(src: string): string {
  const withoutQuery = src.split(/[?#]/u)[0] ?? src;
  const segment = withoutQuery.split("/").filter(Boolean).at(-1) ?? src;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The built-in and external photos every passed definition displays, without
 * repeats. A gallery asset reference is not returned here: it is already a
 * library tile with its own thumbnail, name and size.
 */
export function siteStaticImageTiles(
  ...definitions: ReadonlyArray<SiteDefinition | undefined>
): ReadonlyArray<SiteImageTile> {
  const bySrc = new Map<string, SiteImageTile>();
  for (const definition of definitions) {
    if (definition === undefined) continue;
    for (const src of imageAddressesOf(definition)) {
      if (mediaAssetIdFromPublishedPath(src) !== null) continue;
      if (!bySrc.has(src)) bySrc.set(src, { src, name: imageName(src) });
    }
  }
  return [...bySrc.values()];
}

/**
 * Every gallery asset the passed definitions reference — occurrences, page
 * image fields and published blog images. A library tile for one of these
 * carries an "on the page" badge even when the photo is placed through an image
 * field rather than a named occurrence place.
 */
export function siteUsedAssetIds(
  ...definitions: ReadonlyArray<SiteDefinition | undefined>
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const definition of definitions) {
    if (definition === undefined) continue;
    for (const id of siteDefinitionMediaAssetIds(definition)) ids.add(id);
  }
  return ids;
}

/**
 * Where each photo is used, as lines the owner reads: "About — Top of the
 * page". Photos shows them under the photo, after the words "Used on:".
 *
 * Every page contributes, not only the home page, so a photo placed on any
 * page names that page here. See ADR-0026 and ADR-0043.
 */
export type SitePhotoUsage = ReadonlyMap<string, ReadonlyArray<string>>;

/**
 * One line telling the owner where a photo is used: the page it is on and the
 * place on that page, such as "About — Top of the page". A page whose place
 * has no name of its own is named on its own.
 */
function usageLine(pageTitle: string, placeName: string): string {
  const page = pageTitle.trim();
  const place = placeName.trim();
  if (page === "") return place;
  if (place === "") return page;
  return `${page} — ${place}`;
}

function addUse(
  into: Map<string, Set<string>>,
  assetId: string,
  line: string,
): void {
  const lines = into.get(assetId) ?? new Set<string>();
  lines.add(line);
  into.set(assetId, lines);
}

/** Every gallery asset id an arbitrary value holds, however deeply nested. */
function collectAssetIds(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    const assetId = mediaAssetIdFromPublishedPath(value);
    if (assetId !== null) into.add(assetId);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAssetIds(item, into);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectAssetIds(item, into);
  }
}

/**
 * What to call each photo's place inside one section. The empty key holds the
 * section's own name, which every photo in it falls back to. A foundation
 * section has no installation name, so its photos are named by their page
 * alone — a section type such as "callToAction" is an internal word the owner
 * never sees.
 */
function sectionPlaceNames(
  section: SitePage["sections"][number],
): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  if (section.type !== "registered") return names.set("", "");
  const registration =
    installedPageComponentRegistry.components[section.component];
  if (registration === undefined) return names.set("", "");
  names.set("", registration.label);
  const imageFields = Object.entries(registration.fields).filter(
    ([, field]) => field.control === "image",
  );
  for (const [key, field] of imageFields) {
    const value = (section.props as Record<string, unknown>)[key];
    if (typeof value !== "string") continue;
    const assetId = mediaAssetIdFromPublishedPath(value);
    if (assetId === null) continue;
    // One image field per section needs no field name; more than one does, so
    // the owner can tell which photo is which.
    names.set(
      assetId,
      imageFields.length > 1
        ? `${registration.label}: ${field.label}`
        : registration.label,
    );
  }
  return names;
}

function collectPageUses(
  definition: SiteDefinition,
  into: Map<string, Set<string>>,
): void {
  for (const page of definition.pages) {
    // A photo placed in one of the page's two photo slots.
    for (const occurrence of page.media ?? []) {
      addUse(
        into,
        occurrence.asset.assetId,
        usageLine(page.title, placeNameFor(occurrence.occurrenceId)),
      );
    }
    // A photo chosen for a section. The place is the section's own name,
    // because that is what the owner sees on the page.
    for (const section of page.sections) {
      const placeNames = sectionPlaceNames(section);
      // Every photo the section holds, however deeply — a photo inside a list
      // of cards counts as much as one in the section's own image field.
      const held = new Set<string>();
      collectAssetIds(section, held);
      for (const assetId of held) {
        addUse(
          into,
          assetId,
          usageLine(page.title, placeNames.get(assetId) ?? placeNames.get("")!),
        );
      }
    }
  }
}

function collectPostUses(
  definition: SiteDefinition,
  into: Map<string, Set<string>>,
): void {
  // Only a published post counts, the same rule `siteDefinitionMediaAssetIds`
  // follows, so an unpublished post's photos are not called used. See ADR-0013.
  for (const post of definition.blog?.posts ?? []) {
    if (post.targetVisibility !== "public") continue;
    const ids = new Set<string>();
    collectAssetIds(post.mainImage, ids);
    collectAssetIds(post.seo?.shareImage, ids);
    collectAssetIds(post.body, ids);
    for (const assetId of ids) {
      addUse(into, assetId, usageLine(post.title, "Blog post"));
    }
  }
}

export function sitePhotoUsage(
  ...definitions: ReadonlyArray<SiteDefinition | undefined>
): SitePhotoUsage {
  const uses = new Map<string, Set<string>>();
  for (const definition of definitions) {
    if (definition === undefined) continue;
    collectPageUses(definition, uses);
    collectPostUses(definition, uses);
  }
  return new Map(
    [...uses].map(([assetId, lines]) => [assetId, [...lines].sort()]),
  );
}
