import "server-only";

import type { SiteDefinition } from "@humber-foundry/site-definition";
import {
  mediaAssetIdFromPublishedPath,
  siteDefinitionMediaAssetIds,
} from "@humber-foundry/site-definition";

import { installedPageComponentRegistry } from "@/foundry/page-components";

/**
 * A photo the site displays that is not a library asset — a built-in image an
 * installation ships, or an external image address. It shows in the gallery as
 * a read-only "on the page" tile, so "all your photos" includes every photo the
 * site actually shows, not only the ones uploaded to the library.
 */
export type SiteImageTile = Readonly<{ src: string; name: string }>;

function imageAddressesOf(definition: SiteDefinition): ReadonlySet<string> {
  const found = new Set<string>();
  for (const section of definition.home.sections) {
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
