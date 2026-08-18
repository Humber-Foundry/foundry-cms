"use client";

import { useEffect, useState } from "react";

import type { MediaAsset } from "@humber-foundry/application";

import {
  mediaThumbnailUrl,
  photoSizeLabel,
  photoUsageNames,
} from "./media-gallery-item";
import type { MediaOccurrenceState } from "./media-manager-state";
import { placeNameFor } from "./media-places";
// Type only — erased at compile, so the server-only module is never bundled
// into this client component.
import type { SiteImageTile } from "../src/site-used-photos";

/**
 * The photo library as a grid of tiles. The Photos page and the photo picker
 * both render this component, so a tile looks and behaves the same in each.
 *
 * Each tile carries the thumbnail, the file name, the size, and a badge when
 * the photo is on the page. This component does not decide what a selection
 * means. It reports the choice and shows which tile is chosen.
 */

/**
 * The box a tile reserves for its photo, in CSS pixels. The frame is a fixed
 * shape and the photo fills it, so every tile reserves the same box whatever
 * the photo's own proportions are.
 */
const galleryTileWidth = 176;
const galleryTileHeight = 132;

export function MediaGallery({
  assets,
  occurrences,
  siteImages = [],
  selectableSiteImages = false,
  usedAssetIds,
  libraryToken,
  selectedAssetId,
  disabled = false,
  deletingMessage,
  onSelect,
}: {
  assets: ReadonlyArray<MediaAsset>;
  occurrences: ReadonlyArray<MediaOccurrenceState>;
  /**
   * Photos the site displays that are not library assets — built-in and
   * external images. They render as read-only "on the page" tiles so the
   * gallery is every photo the site uses, not only the uploaded ones.
   */
  siteImages?: ReadonlyArray<SiteImageTile>;
  /**
   * Whether a site photo can be chosen. In the picker it can, so an existing
   * photo can be placed without re-uploading; on the Photos page these tiles
   * stay read-only, because a built-in photo is not a library asset to manage.
   */
  selectableSiteImages?: boolean;
  /**
   * Gallery assets the published site or the draft references. A tile for one
   * of these shows an "on the page" badge even when it is placed through an
   * image field rather than a named occurrence place.
   */
  usedAssetIds?: ReadonlySet<string>;
  /** The library capability, or undefined while one is being granted. */
  libraryToken: string | undefined;
  selectedAssetId: string;
  disabled?: boolean;
  /** What to say about a deletion that has not finished yet. */
  deletingMessage?: string;
  onSelect(assetId: string): void;
}) {
  // Photos stored before thumbnails existed have none, and the media route
  // will not serve the original in a thumbnail's place. Those tiles show the
  // empty frame instead of a broken image.
  const [withoutThumbnail, setWithoutThumbnail] = useState<
    ReadonlySet<string>
  >(new Set());
  // A tile can also fail for a reason that passes: the capability in its
  // address expired while the request was in flight, or the connection
  // dropped. A fresh capability gives every tile a fresh address, so forget
  // the failures and let them load again.
  useEffect(() => setWithoutThumbnail(new Set()), [libraryToken]);
  return (
    <ul className="media-gallery">
      {deletingMessage === undefined ? null : (
        <li className="media-gallery-deleting">{deletingMessage}</li>
      )}
      {assets.map((asset) => {
        const usedIn = photoUsageNames(
          occurrences,
          asset.assetId,
          placeNameFor,
        );
        const badge =
          usedIn.length > 0
            ? `On the page: ${usedIn.join(" and ")}`
            : usedAssetIds?.has(asset.assetId)
              ? "On the page"
              : null;
        return (
          <li key={asset.assetId}>
            <button
              type="button"
              className="media-gallery-tile"
              aria-pressed={selectedAssetId === asset.assetId}
              disabled={disabled}
              onClick={() => onSelect(asset.assetId)}
            >
              <span className="media-gallery-frame">
                {libraryToken === undefined ||
                withoutThumbnail.has(asset.assetId) ? (
                  <span className="media-gallery-placeholder" aria-hidden="true" />
                ) : (
                  /* The thumbnail variant is a small copy, so a full grid
                   * costs a fraction of the library. lazy keeps tiles below
                   * the fold from loading, and the fixed box lets the
                   * browser reserve the space before the photo arrives. */
                  <img
                    alt=""
                    loading="lazy"
                    decoding="async"
                    width={galleryTileWidth}
                    height={galleryTileHeight}
                    src={mediaThumbnailUrl(asset.assetId, libraryToken)}
                    onError={() =>
                      setWithoutThumbnail(
                        (current) => new Set([...current, asset.assetId]),
                      )
                    }
                  />
                )}
              </span>
              <span className="media-gallery-name">{asset.fileName}</span>
              <span className="media-gallery-meta">
                {asset.width}×{asset.height} · {photoSizeLabel(asset.byteLength)}
              </span>
              {badge !== null ? (
                <span className="media-gallery-badge">{badge}</span>
              ) : null}
            </button>
          </li>
        );
      })}
      {siteImages.map((image) => {
        // A photo the site shows that is not a library asset: a built-in image
        // or an external one. It cannot be deleted here, because it is not
        // stored in the library — but it is one of the owner's photos, so it
        // belongs in the gallery. In the picker it can be chosen (by its
        // address); on the Photos page it is shown read-only.
        const frame = (
          <>
            <span className="media-gallery-frame">
              <img alt="" loading="lazy" decoding="async" src={image.src} />
            </span>
            <span className="media-gallery-name">{image.name}</span>
            <span className="media-gallery-meta">Built-in site image</span>
            <span className="media-gallery-badge">On the page</span>
          </>
        );
        return (
          <li key={`site:${image.src}`}>
            {selectableSiteImages ? (
              <button
                type="button"
                className="media-gallery-tile media-gallery-tile-site"
                aria-pressed={selectedAssetId === image.src}
                disabled={disabled}
                onClick={() => onSelect(image.src)}
              >
                {frame}
              </button>
            ) : (
              <div className="media-gallery-tile media-gallery-tile-site">
                {frame}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
