"use client";

import { useState } from "react";

import { mediaAssetIdFromPublishedPath, mediaImageSrc } from "@humber-foundry/site-definition";

import type { ChosenPhoto } from "./media-gallery-item";
import { MediaPicker } from "./media-picker";

/** What the picker needs to load and mutate this site's photos. */
export type EditorMediaContext = Readonly<{
  csrfToken: string;
  workspaceId: string;
}>;

/**
 * The image field in the page editor. Instead of a raw address to type, the
 * owner sees the photo that is set and one clear action — "Change photo" —
 * which opens the shared "Choose or upload a photo" picker (#109). Choosing a
 * gallery photo, or uploading and choosing a new one, stores that photo's
 * reference in the field; the swap then rides the normal draft, preview and
 * publish flow like any other edit.
 */
export function ChangePhotoField({
  label,
  value,
  onChange,
  media,
}: {
  label: string;
  value: string;
  onChange(next: string): void;
  media: EditorMediaContext;
}) {
  const [open, setOpen] = useState(false);
  // The picker hands back a thumbnail that renders now under its short-lived
  // grant. It is kept only to show the owner the photo they just chose; the
  // stored value is the photo's own reference.
  const [chosen, setChosen] = useState<ChosenPhoto | null>(null);

  const isGalleryPhoto = mediaAssetIdFromPublishedPath(value) !== null;
  const previewSrc = chosen !== null ? chosen.thumbnailUrl : isGalleryPhoto ? null : value;

  return (
    <div className="change-photo-field">
      <span className="change-photo-label">{label}</span>
      <div className="change-photo-preview">
        {previewSrc !== null ? (
          <img src={previewSrc} alt="" />
        ) : (
          <p className="change-photo-empty">
            {isGalleryPhoto
              ? "A gallery photo is set. It shows in preview and on the published page."
              : "No photo chosen yet."}
          </p>
        )}
      </div>
      <button
        type="button"
        className="button change-photo-button"
        onClick={() => setOpen(true)}
      >
        Change photo
      </button>
      <MediaPicker
        open={open}
        csrfToken={media.csrfToken}
        workspaceId={media.workspaceId}
        onChoose={(photo) => {
          setChosen(photo);
          onChange(mediaImageSrc(photo.assetId));
        }}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}
