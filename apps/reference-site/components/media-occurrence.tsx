import type { SiteMediaOccurrence } from "@humber-foundry/site-definition";
import type { ReactNode } from "react";

import { mediaCropStyle } from "./media-crop";

export function MediaOccurrence({
  occurrence,
  className,
  children,
  delivery = "authenticated",
  accessToken,
}: {
  occurrence: SiteMediaOccurrence;
  className?: string;
  children?: ReactNode;
  delivery?: "authenticated" | "published";
  accessToken?: string;
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
                )}&accessToken=${encodeURIComponent(accessToken ?? "")}`
          }
          alt=""
          style={crop?.image}
        />
      </div>
      {children}
    </figure>
  );
}
