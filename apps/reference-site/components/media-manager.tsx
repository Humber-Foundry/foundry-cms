"use client";

import { useEffect, useRef, useState } from "react";

import type {
  ContentRevision,
  MediaAsset,
} from "@humber-foundry/application";
import { renderedMediaOccurrenceIds } from "@humber-foundry/application";
import { createMediaOccurrenceId } from "@humber-foundry/application";
import { requireRenderedMediaOccurrenceId } from "@humber-foundry/application";

import { MediaGallery } from "./media-gallery";
import { MediaOccurrence } from "./media-occurrence";
import { MediaPicker } from "./media-picker";
import { createMediaCatalogFence } from "./media-catalog-fence";
import {
  mediaAccessRefreshDelayMs,
  mediaAccessRequestBody,
  parseMediaCatalogGrant,
} from "./media-catalog-grant";
import { placeFor } from "./media-places";
import {
  acceptedPhotoTypes,
  createMediaUploadAttempt,
  isAcceptedPhoto,
} from "./media-upload";
import {
  cropBaseRevisionForEdit,
  cropForCatalogRefresh,
  cropForOccurrence,
  cropForSelectedRevision,
  mediaAssetSelection,
  mediaAssetSelectionForCatalog,
  mediaDeleteFailureMessage,
  mediaOccurrenceAttemptAfterFailure,
  mediaOccurrenceMutationsEnabled,
  mergeMediaOccurrenceState,
  type MediaOccurrenceState,
  upsertMediaAsset,
} from "./media-manager-state";
import {
  mediaUploadAttemptAfterResult,
  type MediaUploadAttempt,
} from "./media-upload-attempt";
import { sendMediaMutationAttempt } from "../src/media-mutation-client";

class MediaMutationRequestError extends Error {
  constructor(
    readonly response: Response,
    readonly body: unknown,
  ) {
    super("media_mutation_failed");
    this.name = "MediaMutationRequestError";
  }
}

export function MediaManager({
  csrfToken,
  workspaceId,
  initialAssets,
  initialOccurrences,
  contentRevision,
  contentStale = false,
  onRevisionSaved = () => undefined,
  onContentStale = () => undefined,
  onAccessGranted = () => undefined,
}: {
  csrfToken: string;
  workspaceId: string;
  initialAssets: ReadonlyArray<MediaAsset>;
  initialOccurrences: ReadonlyArray<MediaOccurrenceState>;
  contentRevision?: ContentRevision;
  contentStale?: boolean;
  onRevisionSaved?(revision: ContentRevision, previewUrl: string): void;
  onContentStale?(): void;
  onAccessGranted?(accessToken: string): void;
}) {
  const [assets, setAssets] = useState([...initialAssets]);
  const [occurrences, setOccurrences] = useState([...initialOccurrences]);
  // Placing or cropping a photo advances the draft's content revision. The
  // next mutation must carry that new revision, not the one the page was
  // rendered with — otherwise every second change is rejected as a conflict
  // until a full reload.
  const [activeContentRevision, setActiveContentRevision] =
    useState(contentRevision);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<string>(
    initialAssets[0]?.assetId ?? "",
  );
  const [occurrenceId, setOccurrenceId] = useState("occurrence_home_hero");
  const [crop, setCrop] = useState(() =>
    cropForOccurrence(initialOccurrences, "occurrence_home_hero"),
  );
  const [previewUrl, setPreviewUrl] = useState<string>();
  // The place the photo picker is open for, or null when it is closed.
  const [pickerPlaceId, setPickerPlaceId] = useState<string | null>(null);
  const [uploadPending, setUploadPending] = useState(false);
  // The upload control's own feedback: what is being uploaded right now, and
  // whether a file is being dragged over the drop zone.
  const [uploadingFileName, setUploadingFileName] = useState<string | null>(
    null,
  );
  const [dragActive, setDragActive] = useState(false);
  const [mediaAccessToken, setMediaAccessToken] = useState<string>();
  const [accessGeneration, setAccessGeneration] = useState(0);
  const mutationTokenRef = useRef(csrfToken);
  const selectedAssetId = useRef(selectedAsset);
  const selectedOccurrenceId = useRef(occurrenceId);
  const uploadAttempt = useRef<MediaUploadAttempt | null>(null);
  const accessAttempt = useRef<{
    workspaceId: string;
    idempotencyKey: string;
  } | null>(null);
  const replaceAttempt = useRef<JsonAttempt | null>(null);
  const cropAttempt = useRef<JsonAttempt | null>(null);
  const cropBaseRevision = useRef<number | null>(null);
  const deleteAttempt = useRef<JsonAttempt | null>(null);
  const catalogFence = useRef(createMediaCatalogFence()).current;
  const occurrenceMutationsEnabled = mediaOccurrenceMutationsEnabled(
    contentStale,
    activeContentRevision,
  );

  type JsonAttempt = Readonly<{ body: unknown; idempotencyKey: string }>;

  useEffect(() => {
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const catalogSnapshot = catalogFence.snapshot();
    if (accessAttempt.current?.workspaceId !== workspaceId) {
      accessAttempt.current = {
        workspaceId,
        idempotencyKey: crypto.randomUUID(),
      };
    }
    const idempotencyKey = accessAttempt.current.idempotencyKey;
    void sendMediaMutationAttempt({
      attempt: {
        body: mediaAccessRequestBody(workspaceId),
        contentType: "application/json",
        idempotencyKey,
      },
      mutationToken: mutationTokenRef.current,
    })
      .then((result) => {
        if (cancelled) return;
        if (!result.response.ok) throw new Error("media_access_grant_failed");
        const grant = parseMediaCatalogGrant(result.body);
        const grantedAssets = grant.assets;
        const grantedOccurrences = grant.occurrences;
        if (accessAttempt.current?.idempotencyKey === idempotencyKey) {
          accessAttempt.current = null;
        }
        mutationTokenRef.current = result.mutationToken;
        setMediaAccessToken(grant.accessToken);
        onAccessGranted(grant.accessToken);
        if (catalogFence.isCurrent(catalogSnapshot)) {
          const mergedOccurrences = mergeMediaOccurrenceState(
            grantedOccurrences,
            activeContentRevision?.definition.home.media ?? [],
          );
          setAssets([...grantedAssets]);
          setOccurrences([...mergedOccurrences]);
          setCrop((current) =>
            cropForCatalogRefresh(
              current,
              cropBaseRevision.current,
              mergedOccurrences,
              selectedOccurrenceId.current,
            ),
          );
          const catalogSelection = mediaAssetSelectionForCatalog(
            selectedAssetId.current,
            grantedAssets,
            deleteAttempt.current,
          );
          if (catalogSelection.assetId !== selectedAssetId.current) {
            replaceAttempt.current = catalogSelection.replaceAttempt;
            deleteAttempt.current = catalogSelection.deleteAttempt;
            selectedAssetId.current = catalogSelection.assetId;
            setSelectedAsset(catalogSelection.assetId);
          }
        }
        refreshTimer = setTimeout(
          () => setAccessGeneration((generation) => generation + 1),
          mediaAccessRefreshDelayMs(grant.accessTokenExpiresAt, Date.now()),
        );
      })
      .catch(() => {
        if (!cancelled) {
          setMessage("Private media access could not be granted. Retrying…");
          refreshTimer = setTimeout(
            () => setAccessGeneration((generation) => generation + 1),
            5_000,
          );
        }
      });
    return () => {
      cancelled = true;
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    };
  }, [accessGeneration, csrfToken, workspaceId]);

  function beginCatalogMutation(): void {
    catalogFence.beginMutation();
  }

  function finishCatalogMutation(): void {
    catalogFence.endMutation();
    accessAttempt.current = null;
    setAccessGeneration((generation) => generation + 1);
  }

  function selectAsset(assetId: string) {
    const selection = mediaAssetSelection(assetId);
    replaceAttempt.current = selection.replaceAttempt;
    deleteAttempt.current = selection.deleteAttempt;
    selectedAssetId.current = selection.assetId;
    setSelectedAsset(selection.assetId);
  }

  /**
   * Moving to another place clears replaceAttempt, cropAttempt and
   * cropBaseRevision, so a retry cannot send the previous place's work to the
   * new one.
   */
  function selectPlace(nextOccurrenceId: string) {
    if (nextOccurrenceId === selectedOccurrenceId.current) return;
    replaceAttempt.current = null;
    cropAttempt.current = null;
    cropBaseRevision.current = null;
    selectedOccurrenceId.current = nextOccurrenceId;
    setOccurrenceId(nextOccurrenceId);
    setCrop(cropForOccurrence(occurrences, nextOccurrenceId));
  }

  async function mutateJson(attempt: JsonAttempt) {
    const result = await sendMediaMutationAttempt({
      attempt: {
        body: JSON.stringify(attempt.body),
        contentType: "application/json",
        idempotencyKey: attempt.idempotencyKey,
      },
      mutationToken: mutationTokenRef.current,
    });
    mutationTokenRef.current = result.mutationToken;
    if (!result.response.ok) {
      if (
        result.response.status === 409 &&
        typeof result.body === "object" &&
        result.body !== null &&
        "error" in result.body &&
        result.body.error === "content_revision_stale"
      ) {
        onContentStale();
      }
      throw new MediaMutationRequestError(result.response, result.body);
    }
    return result.body;
  }

  /** Takes the first image from a picker or a drop and starts the upload. */
  function acceptFiles(files: FileList | null) {
    const file = files?.[0];
    if (file === undefined) return;
    if (!isAcceptedPhoto(file)) {
      setMessage(`“${file.name}” is not a photo file. Use JPEG, PNG or WebP.`);
      return;
    }
    void upload(file);
  }

  async function upload(file?: File) {
    beginCatalogMutation();
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
        attempt: {
          body: attempt.body,
          idempotencyKey: attempt.idempotencyKey,
        },
        mutationToken: mutationTokenRef.current,
      });
      mutationTokenRef.current = result.mutationToken;
      if (!result.response.ok) throw new Error("media_upload_failed");
      const asset = result.body as MediaAsset;
      uploadAttempt.current = mediaUploadAttemptAfterResult(attempt, true);
      setUploadPending(false);
      setAssets((current) => [...upsertMediaAsset(current, asset)]);
      selectAsset(asset.assetId);
      setMessage(
        `“${uploadName}” is in your photo library. To put it on the site, use one of the two places below.`,
      );
    } catch {
      if (uploadAttempt.current !== null) {
        uploadAttempt.current = mediaUploadAttemptAfterResult(
          uploadAttempt.current,
          false,
        );
        setUploadPending(true);
      }
      setMessage(
        "The upload did not finish. Retry it — the same photo is sent again, so nothing is duplicated.",
      );
    } finally {
      setUploadingFileName(null);
      finishCatalogMutation();
      setBusy(false);
    }
  }

  /**
   * Puts a photo in one place. The caller may name the photo, because a
   * photo chosen in the picker is not in `selectedAsset` state yet when the
   * placement starts.
   */
  async function usePhotoInPlace(
    targetOccurrenceId: string,
    assetId: string = selectedAsset,
  ) {
    if (!occurrenceMutationsEnabled) return;
    selectPlace(targetOccurrenceId);
    const current = occurrences.find(
      (occurrence) => occurrence.occurrenceId === targetOccurrenceId,
    );
    beginCatalogMutation();
    setBusy(true);
    try {
      if (activeContentRevision === undefined) return;
      replaceAttempt.current ??= {
        idempotencyKey: crypto.randomUUID(),
        body: {
          operation: "replace",
          occurrenceId: targetOccurrenceId,
          assetId,
          baseRevision: current?.revision ?? 0,
          workspaceId: activeContentRevision.workspaceId,
          contentBaseRevision: activeContentRevision.revision,
        },
      };
      const result = (await mutateJson(replaceAttempt.current)) as {
        occurrence: MediaOccurrenceState;
        contentRevision: ContentRevision;
        previewUrl: string;
      };
      const revision = result.occurrence;
      setOccurrences((items) => [
        ...items.filter(
          (item) => item.occurrenceId !== targetOccurrenceId,
        ),
        revision,
      ]);
      const nextCrop = cropForSelectedRevision(
        selectedOccurrenceId.current,
        revision,
      );
      if (nextCrop !== undefined) setCrop(nextCrop);
      replaceAttempt.current = null;
      cropBaseRevision.current = null;
      setActiveContentRevision(result.contentRevision);
      onRevisionSaved(result.contentRevision, result.previewUrl);
      setPreviewUrl(result.previewUrl);
      setMessage(
        `Done — “${placeFor(targetOccurrenceId).name}” now shows the selected photo.`,
      );
    } catch (error) {
      replaceAttempt.current = mediaOccurrenceAttemptAfterFailure(
        replaceAttempt.current,
        error instanceof MediaMutationRequestError
          ? error.response.status
          : undefined,
        error instanceof MediaMutationRequestError ? error.body : undefined,
      );
      setMessage("That place changed elsewhere or could not be updated. Try again.");
    } finally {
      finishCatalogMutation();
      setBusy(false);
    }
  }

  async function cropSelected() {
    const current = occurrences.find(
      (occurrence) => occurrence.occurrenceId === occurrenceId,
    );
    if (
      current === undefined ||
      activeContentRevision === undefined ||
      !occurrenceMutationsEnabled
    ) {
      return;
    }
    beginCatalogMutation();
    setBusy(true);
    try {
      cropAttempt.current ??= {
        idempotencyKey: crypto.randomUUID(),
        body: {
          operation: "crop",
          occurrenceId,
          baseRevision:
            cropBaseRevision.current ?? current.revision,
          crop,
          workspaceId: activeContentRevision.workspaceId,
          contentBaseRevision: activeContentRevision.revision,
        },
      };
      const result = (await mutateJson(cropAttempt.current)) as {
        occurrence: MediaOccurrenceState;
        contentRevision: ContentRevision;
        previewUrl: string;
      };
      const revision = result.occurrence;
      setOccurrences((items) => [
        ...items.filter((item) => item.occurrenceId !== occurrenceId),
        revision,
      ]);
      cropAttempt.current = null;
      cropBaseRevision.current = null;
      setActiveContentRevision(result.contentRevision);
      onRevisionSaved(result.contentRevision, result.previewUrl);
      setPreviewUrl(result.previewUrl);
      setMessage("Crop saved. The original photo is unchanged.");
    } catch (error) {
      const nextAttempt = mediaOccurrenceAttemptAfterFailure(
        cropAttempt.current,
        error instanceof MediaMutationRequestError
          ? error.response.status
          : undefined,
        error instanceof MediaMutationRequestError ? error.body : undefined,
      );
      cropAttempt.current = nextAttempt;
      if (nextAttempt === null) cropBaseRevision.current = null;
      setMessage("The crop could not be saved. Try again.");
    } finally {
      finishCatalogMutation();
      setBusy(false);
    }
  }

  async function deleteSelected() {
    if (selectedAsset === "") return;
    beginCatalogMutation();
    setBusy(true);
    try {
      deleteAttempt.current ??= {
        idempotencyKey: crypto.randomUUID(),
        body: { operation: "delete", assetId: selectedAsset },
      };
      await mutateJson(deleteAttempt.current);
      deleteAttempt.current = null;
      const remaining = assets.filter(
        (asset) => asset.assetId !== selectedAsset,
      );
      setAssets(remaining);
      selectAsset(remaining[0]?.assetId ?? "");
      setMessage("Photo deleted.");
    } catch (error) {
      setMessage(
        error instanceof MediaMutationRequestError
          ? mediaDeleteFailureMessage(
              error.body,
              error.response.headers.get("retry-after"),
            )
          : "The photo could not be deleted. Retry the same request.",
      );
    } finally {
      finishCatalogMutation();
      setBusy(false);
    }
  }

  const uploading = uploadingFileName !== null;
  const deletionFinishing =
    deleteAttempt.current !== null &&
    !assets.some((asset) => asset.assetId === selectedAsset);
  const selectedInUse = occurrences.some(
    (occurrence) => occurrence.assetId === selectedAsset,
  );

  return (
    <section
      className="content-editor media-library"
      aria-labelledby="media-heading"
    >
      <div className="dashboard-section-heading">
        <div>
          <h2 id="media-heading">Photo library</h2>
          <p>
            Photos you upload are stored privately here. Select one, then
            choose where it appears on the page.
          </p>
        </div>
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
              Choose a photo
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
      {assets.length > 0 || deletionFinishing ? (
        <>
          <MediaGallery
            assets={assets}
            occurrences={occurrences}
            accessToken={mediaAccessToken}
            selectedAssetId={selectedAsset}
            disabled={busy}
            deletingMessage={
              deletionFinishing
                ? "Finishing deletion of the last photo…"
                : undefined
            }
            onSelect={selectAsset}
          />
          <div className="media-asset-actions">
            <button
              className="copy-button"
              type="button"
              disabled={busy || selectedAsset === "" || selectedInUse}
              title={
                selectedInUse
                  ? "This photo is on the page. Put a different photo in its place first."
                  : undefined
              }
              onClick={() => void deleteSelected()}
            >
              Delete selected photo
            </button>
            {selectedInUse ? (
              <span className="media-asset-hint">
                The selected photo is on the page, so it cannot be deleted.
              </span>
            ) : null}
          </div>
          <h3 className="media-places-heading">Where photos appear</h3>
          <p className="media-places-intro">
            The page has two photo places. Select a photo above, then place it.
          </p>
          <div className="media-places">
            {renderedMediaOccurrenceIds.map((id) => {
              const occurrence = occurrences.find(
                (candidate) => candidate.occurrenceId === id,
              );
              const asset =
                occurrence === undefined
                  ? undefined
                  : assets.find(
                      (candidate) => candidate.assetId === occurrence.assetId,
                    );
              const place = placeFor(id);
              return (
                <article className="media-place" key={id}>
                  <h4>{place.name}</h4>
                  <p>{place.detail}</p>
                  {occurrence !== undefined &&
                  asset !== undefined &&
                  mediaAccessToken !== undefined ? (
                    <MediaOccurrence
                      className="media-manager-preview"
                      occurrence={{
                        occurrenceId: requireRenderedMediaOccurrenceId(
                          createMediaOccurrenceId(occurrence.occurrenceId),
                        ),
                        revision: occurrence.revision,
                        asset: {
                          assetId: asset.assetId,
                          width: asset.width,
                          height: asset.height,
                          contentType: asset.contentType,
                        },
                        crop: occurrence.crop,
                      }}
                      accessToken={mediaAccessToken}
                    />
                  ) : (
                    <p className="media-place-empty">No photo here yet.</p>
                  )}
                  <button
                    className="button button-primary"
                    type="button"
                    disabled={
                      busy ||
                      !occurrenceMutationsEnabled ||
                      selectedAsset === "" ||
                      !assets.some(
                        (candidate) => candidate.assetId === selectedAsset,
                      )
                    }
                    onClick={() => void usePhotoInPlace(id)}
                  >
                    Use the selected photo here
                  </button>
                  {/* The picker is the one place an owner can upload a photo
                   * and put it here in the same step. */}
                  <button
                    className="copy-button media-place-picker"
                    type="button"
                    disabled={busy || !occurrenceMutationsEnabled}
                    onClick={() => setPickerPlaceId(id)}
                  >
                    Choose or upload a photo…
                  </button>
                  {occurrence === undefined ? null : (
                    <details
                      className="media-crop-editor"
                      onToggle={(event) => {
                        if (event.currentTarget.open) selectPlace(id);
                      }}
                    >
                      <summary>Adjust crop</summary>
                      <p>
                        Values from 0 to 1 select the part of the photo that
                        shows. The original file never changes.
                      </p>
                      <div className="media-crop-fields">
                        {(["x", "y", "width", "height"] as const).map(
                          (field) => (
                            <label key={field}>
                              {field}
                              <input
                                type="number"
                                disabled={busy || occurrenceId !== id}
                                min={
                                  field === "width" || field === "height"
                                    ? 0.01
                                    : 0
                                }
                                max={1}
                                step={0.01}
                                value={occurrenceId === id ? crop[field] : ""}
                                onChange={(event) => {
                                  cropAttempt.current = null;
                                  const currentRevision =
                                    occurrences.find(
                                      (candidate) =>
                                        candidate.occurrenceId ===
                                        occurrenceId,
                                    )?.revision ?? 0;
                                  cropBaseRevision.current =
                                    cropBaseRevisionForEdit(
                                      cropBaseRevision.current,
                                      currentRevision,
                                    );
                                  setCrop((current) => ({
                                    ...current,
                                    [field]: Number(event.target.value),
                                  }));
                                }}
                              />
                            </label>
                          ),
                        )}
                      </div>
                      <button
                        className="copy-button"
                        type="button"
                        disabled={
                          busy ||
                          occurrenceId !== id ||
                          !occurrenceMutationsEnabled
                        }
                        onClick={() => void cropSelected()}
                      >
                        Save crop
                      </button>
                    </details>
                  )}
                </article>
              );
            })}
          </div>
          {previewUrl === undefined ? null : (
            <p>
              <a
                href={`${previewUrl}&accessToken=${encodeURIComponent(
                  mediaAccessToken ?? "",
                )}`}
              >
                See the draft site with these photos ↗
              </a>
            </p>
          )}
        </>
      ) : (
        <p className="media-empty">
          No photos yet. Upload one above and it appears here.
        </p>
      )}
      {contentStale ? (
        <p>
          This draft is based on an older version of the site, so photos
          cannot be placed or cropped right now. Start a fresh draft first;
          uploading and deleting photos still works.
        </p>
      ) : null}
      <p role="status" aria-live="polite">{message}</p>
      <MediaPicker
        open={pickerPlaceId !== null}
        // The picker keeps its own token and refreshes a stale one itself, so
        // it starts from the token this page was rendered with.
        csrfToken={csrfToken}
        workspaceId={workspaceId}
        title={
          pickerPlaceId === null
            ? undefined
            : `Choose or upload a photo for “${placeFor(pickerPlaceId).name}”`
        }
        confirmLabel="Use this photo here"
        onChoose={(photo) => {
          if (pickerPlaceId === null) return;
          selectAsset(photo.assetId);
          void usePhotoInPlace(pickerPlaceId, photo.assetId);
        }}
        onClose={() => setPickerPlaceId(null)}
      />
    </section>
  );
}
