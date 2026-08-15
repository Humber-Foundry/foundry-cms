"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { MediaAsset } from "@humber-foundry/application";

import { MediaGallery } from "./media-gallery";
import {
  chosenPhoto,
  type ChosenPhoto,
} from "./media-gallery-item";
import {
  mediaAccessRefreshDelayMs,
  mediaAccessRequestBody,
  parseMediaCatalogGrant,
} from "./media-catalog-grant";
import type { MediaOccurrenceState } from "./media-manager-state";
import {
  acceptedPhotoTypes,
  createMediaUploadAttempt,
  isAcceptedPhoto,
} from "./media-upload";
import type { MediaUploadAttempt } from "./media-upload-attempt";
import { sendMediaMutationAttempt } from "../src/media-mutation-client";

/**
 * "Choose or upload a photo" — the one photo picker.
 *
 * Every surface that needs a photo opens this dialog instead of building its
 * own upload and library handling. The owner picks a photo already in the
 * library, or uploads a new one and picks it in the same step. The dialog
 * reports the chosen photo to its caller and closes.
 *
 * The dialog holds no draft content and changes nothing on the page. Placing
 * the chosen photo is the caller's business.
 */
export function MediaPicker({
  open,
  csrfToken,
  workspaceId,
  title = "Choose or upload a photo",
  confirmLabel = "Use this photo",
  onChoose,
  onClose,
}: {
  open: boolean;
  csrfToken: string;
  workspaceId: string;
  title?: string;
  confirmLabel?: string;
  onChoose(photo: ChosenPhoto): void;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const mutationTokenRef = useRef(csrfToken);
  const uploadAttempt = useRef<MediaUploadAttempt | null>(null);
  /** A just-uploaded photo, waiting for a capability that covers it. */
  const pendingSelection = useRef<string | null>(null);
  const [assets, setAssets] = useState<ReadonlyArray<MediaAsset>>([]);
  const [occurrences, setOccurrences] = useState<
    ReadonlyArray<MediaOccurrenceState>
  >([]);
  const [accessToken, setAccessToken] = useState<string>();
  const [accessGeneration, setAccessGeneration] = useState(0);
  const [selectedAsset, setSelectedAsset] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadingFileName, setUploadingFileName] = useState<string | null>(
    null,
  );
  const [uploadPending, setUploadPending] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  // A native dialog gives the modal its own focus handling and its own
  // Escape key, so the picker does not reimplement either.
  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    void sendMediaMutationAttempt({
      attempt: {
        body: mediaAccessRequestBody(workspaceId),
        contentType: "application/json",
        idempotencyKey: crypto.randomUUID(),
      },
      mutationToken: mutationTokenRef.current,
    })
      .then((result) => {
        if (cancelled) return;
        if (!result.response.ok) throw new Error("media_access_grant_failed");
        const grant = parseMediaCatalogGrant(result.body);
        mutationTokenRef.current = result.mutationToken;
        setAssets(grant.assets);
        setOccurrences(grant.occurrences);
        setAccessToken(grant.accessToken);
        const pending = pendingSelection.current;
        if (
          pending !== null &&
          grant.assets.some((asset) => asset.assetId === pending)
        ) {
          pendingSelection.current = null;
          setSelectedAsset(pending);
        }
        refreshTimer = setTimeout(
          () => setAccessGeneration((generation) => generation + 1),
          mediaAccessRefreshDelayMs(grant.accessTokenExpiresAt, Date.now()),
        );
      })
      .catch(() => {
        if (cancelled) return;
        setMessage("Your photos could not be loaded. Retrying…");
        refreshTimer = setTimeout(
          () => setAccessGeneration((generation) => generation + 1),
          5_000,
        );
      });
    return () => {
      cancelled = true;
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    };
  }, [accessGeneration, open, workspaceId]);

  const closePicker = useCallback(() => {
    setMessage("");
    setUploadPending(false);
    uploadAttempt.current = null;
    onClose();
  }, [onClose]);

  async function upload(file?: File) {
    setBusy(true);
    setMessage("");
    try {
      if (file !== undefined) {
        uploadAttempt.current = await createMediaUploadAttempt(file);
      }
      const attempt = uploadAttempt.current;
      if (attempt === null) return;
      const source = attempt.body.get("source");
      const uploadName = source instanceof File ? source.name : "photo";
      setUploadingFileName(uploadName);
      const result = await sendMediaMutationAttempt({
        attempt: { body: attempt.body, idempotencyKey: attempt.idempotencyKey },
        mutationToken: mutationTokenRef.current,
      });
      mutationTokenRef.current = result.mutationToken;
      if (!result.response.ok) throw new Error("media_upload_failed");
      const asset = result.body as MediaAsset;
      uploadAttempt.current = null;
      setUploadPending(false);
      // The capability the picker holds was granted before this photo
      // existed, so it does not cover it. Ask for the catalog again and
      // select the new photo once a capability that covers it arrives.
      pendingSelection.current = asset.assetId;
      setAccessGeneration((generation) => generation + 1);
      setMessage(`“${uploadName}” is ready. Choose it below to use it.`);
    } catch {
      if (uploadAttempt.current !== null) setUploadPending(true);
      setMessage(
        "The upload did not finish. Retry it — the same photo is sent again, so nothing is duplicated.",
      );
    } finally {
      setUploadingFileName(null);
      setBusy(false);
    }
  }

  function acceptFiles(files: FileList | null) {
    const file = files?.[0];
    if (file === undefined) return;
    if (!isAcceptedPhoto(file)) {
      setMessage(`“${file.name}” is not a photo file. Use JPEG, PNG or WebP.`);
      return;
    }
    void upload(file);
  }

  function choose() {
    const asset = assets.find(
      (candidate) => candidate.assetId === selectedAsset,
    );
    if (asset === undefined || accessToken === undefined) return;
    onChoose(chosenPhoto(asset, accessToken));
    closePicker();
  }

  const uploading = uploadingFileName !== null;

  return (
    <dialog
      className="media-picker"
      ref={dialog}
      aria-labelledby="media-picker-title"
      onClose={closePicker}
      onCancel={closePicker}
    >
      <div className="media-picker-head">
        <h2 id="media-picker-title">{title}</h2>
        <button
          className="copy-button"
          type="button"
          disabled={busy}
          onClick={closePicker}
        >
          Close
        </button>
      </div>
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
          if (!busy) acceptFiles(event.dataTransfer.files);
        }}
      >
        {uploading ? (
          <div className="media-upload-progress" role="status">
            <span>Uploading “{uploadingFileName}”…</span>
            <span className="media-activity-track" aria-hidden="true">
              <span className="media-activity-fill" />
            </span>
          </div>
        ) : (
          <>
            <label className="button button-secondary">
              Upload a photo
              <input
                hidden
                type="file"
                accept={acceptedPhotoTypes.join(",")}
                disabled={busy}
                onChange={(event) => {
                  acceptFiles(event.currentTarget.files);
                  event.currentTarget.value = "";
                }}
              />
            </label>
            <p>or drag a photo here — JPEG, PNG or WebP</p>
          </>
        )}
      </div>
      {uploadPending ? (
        <button
          className="button button-secondary media-upload-retry"
          type="button"
          disabled={busy}
          onClick={() => void upload()}
        >
          Retry the upload
        </button>
      ) : null}
      {assets.length > 0 ? (
        <MediaGallery
          assets={assets}
          occurrences={occurrences}
          accessToken={accessToken}
          selectedAssetId={selectedAsset}
          disabled={busy}
          onSelect={setSelectedAsset}
        />
      ) : (
        <p className="media-empty">
          No photos yet. Upload one above and it appears here.
        </p>
      )}
      <p role="status" aria-live="polite">
        {message}
      </p>
      <div className="media-picker-actions">
        <button
          className="button button-primary"
          type="button"
          disabled={busy || selectedAsset === "" || accessToken === undefined}
          onClick={choose}
        >
          {confirmLabel}
        </button>
        <button
          className="copy-button"
          type="button"
          disabled={busy}
          onClick={closePicker}
        >
          Cancel
        </button>
      </div>
    </dialog>
  );
}
