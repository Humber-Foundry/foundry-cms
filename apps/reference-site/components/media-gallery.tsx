"use client";

import type { MediaAsset } from "@humber-foundry/application";

import {
  mediaThumbnailUrl,
  photoSizeLabel,
  photoTileHeight,
  photoUsageNames,
} from "./media-gallery-item";
import type { MediaOccurrenceState } from "./media-manager-state";
import { placeNameFor } from "./media-places";

/**
 * The photo library as a grid of tiles. Every surface that shows the
 * library — the Photos page and the photo picker — renders this component,
 * so a tile looks and behaves the same everywhere.
 *
 * Each tile carries the thumbnail, the file name, the size, and a badge when
 * the photo is on the page. Selecting a tile is the caller's business: this
 * component reports the choice and shows which tile is chosen.
 */

/** The width a tile reserves for its photo, in CSS pixels. */
const galleryTileWidth = 176;

export function MediaGallery({
  assets,
  occurrences,
  accessToken,
  selectedAssetId,
  disabled = false,
  deletingMessage,
  onSelect,
}: {
  assets: ReadonlyArray<MediaAsset>;
  occurrences: ReadonlyArray<MediaOccurrenceState>;
  /** The media capability, or undefined while one is still being granted. */
  accessToken: string | undefined;
  selectedAssetId: string;
  disabled?: boolean;
  /** What to say about a deletion that has not finished yet. */
  deletingMessage?: string;
  onSelect(assetId: string): void;
}) {
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
        const tileHeight = photoTileHeight(
          asset.width,
          asset.height,
          galleryTileWidth,
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
                {accessToken === undefined ? (
                  <span className="media-gallery-placeholder" aria-hidden="true" />
                ) : (
                  /* The thumbnail variant is a small copy, so a full grid
                   * costs a fraction of the library. lazy keeps tiles below
                   * the fold from loading, and the tile size lets the
                   * browser reserve the space. */
                  <img
                    alt=""
                    loading="lazy"
                    decoding="async"
                    width={galleryTileWidth}
                    height={tileHeight}
                    src={mediaThumbnailUrl(asset.assetId, accessToken)}
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
