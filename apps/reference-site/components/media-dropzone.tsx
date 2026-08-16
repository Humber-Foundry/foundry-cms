"use client";

import { useState } from "react";

import { acceptedPhotoTypes } from "./media-upload";

/**
 * The control that takes a photo file, by drag-and-drop or by choosing one.
 *
 * The Photos page and the photo picker both render it, so uploading looks and
 * behaves the same in each. It holds only whether a file is being dragged
 * over it. What happens to the file, and what is said about the result, are
 * the caller's.
 */
export function MediaDropzone({
  busy,
  uploadingFileName,
  uploadPending,
  chooseLabel,
  onFiles,
  onRetry,
}: {
  busy: boolean;
  /** The file being uploaded right now, or null when none is. */
  uploadingFileName: string | null;
  /** True when an upload failed and the same request can be sent again. */
  uploadPending: boolean;
  chooseLabel: string;
  onFiles(files: FileList | null): void;
  onRetry(): void;
}) {
  const [dragActive, setDragActive] = useState(false);
  return (
    <>
      <div
        className={`media-dropzone${dragActive ? " is-dragover" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          if (!busy) onFiles(event.dataTransfer.files);
        }}
      >
        {uploadingFileName === null ? (
          <>
            <label className="button button-secondary">
              {chooseLabel}
              <input
                hidden
                type="file"
                accept={acceptedPhotoTypes.join(",")}
                disabled={busy}
                onChange={(event) => {
                  onFiles(event.currentTarget.files);
                  event.currentTarget.value = "";
                }}
              />
            </label>
            <p>or drag a photo here — JPEG, PNG or WebP</p>
          </>
        ) : (
          <div className="media-upload-progress" role="status">
            <span>Uploading “{uploadingFileName}”…</span>
            <span className="media-activity-track" aria-hidden="true">
              <span className="media-activity-fill" />
            </span>
          </div>
        )}
      </div>
      {uploadPending ? (
        <button
          className="button button-secondary media-upload-retry"
          type="button"
          disabled={busy}
          onClick={onRetry}
        >
          Retry the upload
        </button>
      ) : null}
    </>
  );
}
