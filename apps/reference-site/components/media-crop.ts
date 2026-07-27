import type { MediaAsset, MediaCrop } from "@foundry/application";

export function mediaCropStyle(
  crop: MediaCrop,
  asset: Pick<MediaAsset, "width" | "height">,
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
