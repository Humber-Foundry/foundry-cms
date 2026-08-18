"use client";

import { useState } from "react";

import { mediaAssetIdFromPublishedPath } from "@humber-foundry/site-definition";

import type { ChosenPhoto } from "./media-gallery-item";
import { MediaPicker } from "./media-picker";
// Type only — erased at compile, so the server-only module is never bundled
// into this client component.
import type { SiteImageTile } from "../src/site-used-photos";

/** What the picker needs to load and mutate this site's photos. */
export type EditorMediaContext = Readonly<{
  csrfToken: string;
  workspaceId: string;
  /**
   * The built-in and external photos the site already shows. The picker lists
   * these alongside the uploaded library so an existing photo can be chosen,
   * not only a newly uploaded one. Absent on a surface that has none.
   */
  siteImages?: ReadonlyArray<SiteImageTile>;
}>;

/**
 * An image field in a composer. Instead of a raw address to type, the owner
 * sees the photo that is set with a "Change photo" control on the image itself,
 * the same way a page photo is changed on the canvas (#110). The control opens
 * the shared "Choose or upload a photo" picker (#109); choosing a photo — an
 * existing one or a freshly uploaded one — stores that photo's address in the
 * field, and the swap then rides the normal draft, preview and publish flow.
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
  // stored value is the photo's own address.
  const [chosen, setChosen] = useState<ChosenPhoto | null>(null);

  const isGalleryPhoto = mediaAssetIdFromPublishedPath(value) !== null;
  const previewSrc =
    chosen !== null ? chosen.thumbnailUrl : isGalleryPhoto ? null : value;
  const hasPreview = previewSrc !== null && previewSrc !== "";

  return (
    <div className="change-photo-field">
      <span className="change-photo-label">{label}</span>
      <div className="change-photo-preview" data-has-photo={hasPreview}>
        {hasPreview ? (
          <>
            <img src={previewSrc} alt="" />
            {/* The action sits on the image itself, not below it. */}
            <span className="change-photo-overlay">
              <button
                type="button"
                className="button change-photo-change"
                onClick={() => setOpen(true)}
              >
                <span className="change-photo-change-icon" aria-hidden="true">
                  ⤢
                </span>
                Change photo
              </button>
            </span>
          </>
        ) : (
          <div className="change-photo-empty-inner">
            <p className="change-photo-empty">
              {isGalleryPhoto
                ? "A gallery photo is set. It shows in preview and on the published page."
                : "No photo chosen yet."}
            </p>
            <button
              type="button"
              className="button change-photo-change"
              onClick={() => setOpen(true)}
            >
              Change photo
            </button>
          </div>
        )}
      </div>
      <MediaPicker
        open={open}
        csrfToken={media.csrfToken}
        workspaceId={media.workspaceId}
        siteImages={media.siteImages}
        onChoose={(photo) => {
          setChosen(photo);
          onChange(photo.imageSrc);
        }}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}
