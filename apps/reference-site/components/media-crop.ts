import type { SiteMediaCrop } from "@humber-foundry/site-definition";

export function mediaCropStyle(
  crop: SiteMediaCrop,
  asset: Readonly<{ width: number; height: number }>,
) {
  return {
    frame: {
      aspectRatio:
        (crop.width * asset.width) / (crop.height * asset.height),
      overflow: "hidden",
    },
    image: {
      width: `${100 / crop.width}%`,
      height: `${100 / crop.height}%`,
      maxWidth: "none",
      transform: `translate(-${crop.x * 100}%, -${crop.y * 100}%)`,
    },
  } as const;
}
