import type { SiteMediaOccurrence } from "@foundry/site-definition";
import type { ReactNode } from "react";

import { mediaCropStyle } from "./media-crop";

export function MediaOccurrence({
  occurrence,
  className,
  children,
  delivery = "authenticated",
}: {
  occurrence: SiteMediaOccurrence;
  className?: string;
  children?: ReactNode;
  delivery?: "authenticated" | "published";
}) {
  const crop =
    occurrence.crop === null
      ? undefined
      : mediaCropStyle(occurrence.crop, occurrence.asset);
  return (
    <figure
      className={className}
      data-media-occurrence={occurrence.occurrenceId}
    >
      <div className="media-crop-frame" style={crop?.frame}>
        <img
          src={
            delivery === "published"
              ? `/api/media/${encodeURIComponent(occurrence.asset.assetId)}`
              : `/api/foundry-cms/media?assetId=${encodeURIComponent(
                  occurrence.asset.assetId,
                )}`
          }
          alt=""
          style={crop?.image}
        />
      </div>
      {children}
    </figure>
  );
}
