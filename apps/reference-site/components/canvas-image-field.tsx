"use client";

import { useEffect, useRef, useState } from "react";
import { registerOverlayPortal } from "@puckeditor/core";

import type { ChosenPhoto } from "./media-gallery-item";

/**
 * How the canvas asks the editor to open the shared photo picker. The picker
 * itself lives in the editor's own document, not in the canvas iframe, so it
 * opens as a full-screen dialog rather than a box trapped inside the canvas.
 * The canvas passes what to do with the chosen photo, and keeps its own copy so
 * the picked photo shows on the image at once.
 */
export type OpenPhotoPicker = (onChoose: (photo: ChosenPhoto) => void) => void;

/**
 * A photo on the page canvas, editable where it stands. The image renders as it
 * always did; while its section is selected, a "Change photo" control sits on
 * the image itself. Choosing a photo swaps it in place through the normal draft
 * flow (ADR-0012) — no side panel, no address to type.
 *
 * The canvas draws page photos with published delivery, so a gallery photo just
 * chosen would not resolve here until it is published. The chosen thumbnail is
 * held and shown in its place, so the owner sees the new photo on the page at
 * once; the exact preview and the published page then show it in full.
 */
export function CanvasImageField({
  displaySrc,
  alt,
  openPhotoPicker,
  onChange,
}: {
  /** The address the section would draw for this field right now. */
  displaySrc: string;
  alt: string;
  openPhotoPicker: OpenPhotoPicker;
  onChange(next: string): void;
}) {
  const [chosen, setChosen] = useState<ChosenPhoto | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Puck treats a click on the canvas as selecting a section; the portal makes
  // this control interactive instead, exactly like the in-place text editor.
  useEffect(() => {
    if (overlayRef.current === null) return;
    return registerOverlayPortal(overlayRef.current, {
      disableDragOnFocus: true,
    });
  }, []);

  const shownSrc = chosen !== null ? chosen.thumbnailUrl : displaySrc;
  const hasPhoto = shownSrc !== "";

  return (
    <span className="canvas-image-field" data-has-photo={hasPhoto}>
      {hasPhoto ? (
        <img className="canvas-image-photo" src={shownSrc} alt={alt} />
      ) : (
        <span className="canvas-image-empty">No photo yet</span>
      )}
      <span
        className="canvas-image-overlay"
        ref={overlayRef}
        onClick={(event) => {
          // The control lives inside the section; a click here must change the
          // photo, never re-select or drag the section underneath it.
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <button
          type="button"
          className="button canvas-image-change"
          onClick={() =>
            openPhotoPicker((photo) => {
              setChosen(photo);
              onChange(photo.imageSrc);
            })
          }
        >
          <span className="canvas-image-change-icon" aria-hidden="true">
            ⤢
          </span>
          {hasPhoto ? "Change photo" : "Choose a photo"}
        </button>
      </span>
    </span>
  );
}
