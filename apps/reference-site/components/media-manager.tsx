"use client";

import { useEffect, useRef, useState } from "react";

import type {
  ContentRevision,
  MediaAsset,
} from "@humber-foundry/application";
import { renderedMediaOccurrenceIds } from "@humber-foundry/application";
import { createMediaOccurrenceId } from "@humber-foundry/application";
import { requireRenderedMediaOccurrenceId } from "@humber-foundry/application";

import { MediaOccurrence } from "./media-occurrence";
import { createMediaCatalogFence } from "./media-catalog-fence";
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

async function imageDimensions(file: File) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

class MediaMutationRequestError extends Error {
  constructor(
    readonly response: Response,
    readonly body: unknown,
  ) {
    super("media_mutation_failed");
    this.name = "MediaMutationRequestError";
  }
}

const acceptedPhotoTypes = ["image/jpeg", "image/png", "image/webp"];

/** Where a photo can appear on the page, in the owner's words. */
type PlaceId = "occurrence_home_hero" | "occurrence_home_detail";

const places: Readonly<Record<PlaceId, { name: string; detail: string }>> = {
  occurrence_home_hero: {
    name: "Top of the page",
    detail: "The large photo visitors see first.",
  },
  occurrence_home_detail: {
    name: "Further down the page",
    detail: "The smaller photo beside the text.",
  },
};

/**
 * The place with this id, or a stand-in built from the id itself. Occurrence
 * ids arrive from the server, so one that this build does not know about is
 * possible; showing the raw id beats showing nothing.
 */
function placeFor(id: string): { name: string; detail: string } {
  return places[id as PlaceId] ?? { name: id, detail: "" };
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
        body: JSON.stringify({ operation: "access", workspaceId }),
        contentType: "application/json",
        idempotencyKey,
      },
      mutationToken: mutationTokenRef.current,
    })
      .then((result) => {
        if (
          cancelled ||
          !result.response.ok ||
          typeof result.body !== "object" ||
          result.body === null ||
          !("assets" in result.body) ||
          !Array.isArray(result.body.assets) ||
          !("occurrences" in result.body) ||
          !Array.isArray(result.body.occurrences) ||
          !("accessToken" in result.body) ||
          typeof result.body.accessToken !== "string" ||
          !("accessTokenExpiresAt" in result.body) ||
          typeof result.body.accessTokenExpiresAt !== "number"
        ) {
          throw new Error("media_access_grant_failed");
        }
        const grantedAssets = result.body.assets as ReadonlyArray<MediaAsset>;
        const grantedOccurrences =
          result.body.occurrences as ReadonlyArray<MediaOccurrenceState>;
        if (accessAttempt.current?.idempotencyKey === idempotencyKey) {
          accessAttempt.current = null;
        }
        mutationTokenRef.current = result.mutationToken;
        setMediaAccessToken(result.body.accessToken);
        onAccessGranted(result.body.accessToken);
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
          Math.max(
            1_000,
            result.body.accessTokenExpiresAt * 1_000 -
              Date.now() -
              30_000,
          ),
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
    if (!acceptedPhotoTypes.includes(file.type)) {
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
        const dimensions = await imageDimensions(file);
        const assetId = `asset_${crypto.randomUUID().replaceAll("-", "")}`;
        const body = new FormData();
        body.set("assetId", assetId);
        body.set("width", String(dimensions.width));
        body.set("height", String(dimensions.height));
        body.set("source", file);
        uploadAttempt.current = {
          assetId,
          idempotencyKey: crypto.randomUUID(),
          body,
        };
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

  async function usePhotoInPlace(targetOccurrenceId: string) {
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
          assetId: selectedAsset,
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
          <ul className="media-asset-list">
            {deletionFinishing ? (
              <li className="media-asset-deleting">
                Finishing deletion of the last photo…
              </li>
            ) : null}
            {assets.map((asset) => {
              const usedIn = occurrences
                .filter((occurrence) => occurrence.assetId === asset.assetId)
                .map(
                  (occurrence) =>
                    placeFor(occurrence.occurrenceId).name,
                );
              return (
                <li key={asset.assetId}>
                  <button
                    type="button"
                    className="media-asset-row"
                    aria-pressed={selectedAsset === asset.assetId}
                    disabled={busy}
                    onClick={() => selectAsset(asset.assetId)}
                  >
                    {mediaAccessToken === undefined ? (
                      <span className="media-asset-thumb" aria-hidden="true" />
                    ) : (
                      /* The media route serves the stored original, so this
                       * 3.5rem square costs the whole file. lazy keeps the
                       * rows below the fold from fetching at all, and the
                       * real dimensions let the browser reserve the space.
                       * A resized variant is still the actual fix. */
                      <img
                        className="media-asset-thumb"
                        alt=""
                        loading="lazy"
                        decoding="async"
                        width={asset.width}
                        height={asset.height}
                        src={`/api/foundry-cms/media?assetId=${encodeURIComponent(
                          asset.assetId,
                        )}&accessToken=${encodeURIComponent(mediaAccessToken)}`}
                      />
                    )}
                    <span className="media-asset-name">{asset.fileName}</span>
                    <span className="media-asset-meta">
                      {asset.width}×{asset.height}
                      {usedIn.length > 0
                        ? ` · On the page: ${usedIn.join(" and ")}`
                        : " · Not on the page"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
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
    </section>
  );
}
