import type {
  MediaAsset,
  MediaOccurrenceRevision,
} from "@foundry/application";
import type { ReactNode } from "react";

import { mediaCropStyle } from "./media-crop";

export function MediaOccurrence({
  occurrence,
  asset,
  className,
  children,
}: {
  occurrence: MediaOccurrenceRevision;
  asset: MediaAsset;
  className?: string;
  children?: ReactNode;
}) {
  const crop =
    occurrence.crop === null
      ? undefined
      : mediaCropStyle(occurrence.crop, asset);
  return (
    <figure
      className={className}
      data-media-occurrence={occurrence.occurrenceId}
    >
      <div className="media-crop-frame" style={crop?.frame}>
        <img
          src={`/api/media/${encodeURIComponent(asset.assetId)}`}
          alt=""
          style={crop?.image}
        />
      </div>
      {children}
    </figure>
  );
}
