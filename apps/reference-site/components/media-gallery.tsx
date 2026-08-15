"use client";

import { useState } from "react";

import type { MediaAsset } from "@humber-foundry/application";

import {
  mediaThumbnailUrl,
  photoSizeLabel,
  photoUsageNames,
} from "./media-gallery-item";
import type { MediaOccurrenceState } from "./media-manager-state";
import { placeNameFor } from "./media-places";

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
  libraryToken,
  selectedAssetId,
  disabled = false,
  deletingMessage,
  onSelect,
}: {
  assets: ReadonlyArray<MediaAsset>;
  occurrences: ReadonlyArray<MediaOccurrenceState>;
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
              {usedIn.length > 0 ? (
                <span className="media-gallery-badge">
                  On the page: {usedIn.join(" and ")}
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
