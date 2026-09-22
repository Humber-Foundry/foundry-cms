"use client";

import { useEffect, useRef, useState } from "react";

import type { MediaAsset } from "@humber-foundry/application";

import { MediaDropzone } from "./media-dropzone";
import { MediaGallery } from "./media-gallery";
import { createMediaCatalogFence } from "./media-catalog-fence";
import {
  mediaAccessRefreshDelayMs,
  mediaAccessRequestBody,
  parseMediaCatalogGrant,
} from "./media-catalog-grant";
import {
  mediaThumbnailUrl,
  photoSizeLabel,
  photoUsage,
  photoUsageBadges,
} from "./media-gallery-item";
import { createMediaUploadAttempt, isAcceptedPhoto } from "./media-upload";
import {
  mediaAssetSelection,
  mediaAssetSelectionForCatalog,
  mediaDeleteFailureMessage,
  upsertMediaAsset,
} from "./media-manager-state";
import {
  mediaUploadAttemptAfterResult,
  type MediaUploadAttempt,
} from "./media-upload-attempt";
import { sendMediaMutationAttempt } from "../src/media-mutation-client";
// Type only — erased at compile, so the server-only module is never bundled
// into this client component.
import type { SiteImageTile, SitePhotoUsage } from "../src/site-used-photos";

class MediaMutationRequestError extends Error {
  constructor(
    readonly response: Response,
    readonly body: unknown,
  ) {
    super("media_mutation_failed");
    this.name = "MediaMutationRequestError";
  }
}

/**
 * The photo library.
 *
 * Photos is a library and nothing else: upload a photo, look at it, see where
 * it is used, and delete one that is used nowhere. A photo is put on a page in
 * the page editor, at the photo itself, or through the MCP photo tool. See
 * ADR-0043.
 */
export function MediaManager({
  csrfToken,
  workspaceId,
  initialAssets,
  siteImages = [],
  usage,
  usedAssetIds,
}: {
  csrfToken: string;
  workspaceId: string;
  initialAssets: ReadonlyArray<MediaAsset>;
  /** Photos the site shows that are not library assets (built-in/external). */
  siteImages?: ReadonlyArray<SiteImageTile>;
  /** Where each photo is used, one line per use. */
  usage?: SitePhotoUsage;
  /** Gallery assets the published site or the draft references. */
  usedAssetIds?: ReadonlySet<string>;
}) {
  const [assets, setAssets] = useState([...initialAssets]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<string>(
    initialAssets[0]?.assetId ?? "",
  );
  const [uploadPending, setUploadPending] = useState(false);
  // What is being uploaded right now, or null when nothing is.
  const [uploadingFileName, setUploadingFileName] = useState<string | null>(
    null,
  );
  // Unlocks a thumbnail of any photo, including one not on the page.
  const [mediaLibraryToken, setMediaLibraryToken] = useState<string>();
  const [accessGeneration, setAccessGeneration] = useState(0);
  const mutationTokenRef = useRef(csrfToken);
  const selectedAssetId = useRef(selectedAsset);
  const uploadAttempt = useRef<MediaUploadAttempt | null>(null);
  const accessAttempt = useRef<{
    workspaceId: string;
    idempotencyKey: string;
  } | null>(null);
  const deleteAttempt = useRef<JsonAttempt | null>(null);
  const catalogFence = useRef(createMediaCatalogFence()).current;

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
        if (accessAttempt.current?.idempotencyKey === idempotencyKey) {
          accessAttempt.current = null;
        }
        mutationTokenRef.current = result.mutationToken;
        setMediaLibraryToken(grant.libraryToken);
        if (catalogFence.isCurrent(catalogSnapshot)) {
          setAssets([...grantedAssets]);
          const catalogSelection = mediaAssetSelectionForCatalog(
            selectedAssetId.current,
            grantedAssets,
            deleteAttempt.current,
          );
          if (catalogSelection.assetId !== selectedAssetId.current) {
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
    deleteAttempt.current = selection.deleteAttempt;
    selectedAssetId.current = selection.assetId;
    setSelectedAsset(selection.assetId);
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
        `“${uploadName}” is in your photo library. To put it on a page, open the page and change the photo there.`,
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

  const deletionFinishing =
    deleteAttempt.current !== null &&
    !assets.some((asset) => asset.assetId === selectedAsset);
  const selectedPhoto = assets.find((asset) => asset.assetId === selectedAsset);
  // Where the selected photo is used. A use that no line names still counts,
  // so the guard below never deletes a photo the site needs.
  const selectedUse = photoUsage(selectedAsset, usage, usedAssetIds);
  const refusalMessage =
    selectedUse.state === "named"
      ? `This photo cannot be deleted. It is used on ${selectedUse.lines.join("; ")}. Change the photo ${selectedUse.lines.length === 1 ? "there" : "in each place"} first.`
      : "This photo cannot be deleted. Your site still uses it. Change it where it is used first.";

  async function deleteSelected() {
    if (selectedAsset === "") return;
    // The library refuses a photo the site still uses, and says where it is
    // used. The server refuses it as well; this refusal is the one the owner
    // reads.
    if (selectedUse.state !== "unused") {
      setMessage(refusalMessage);
      return;
    }
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

  return (
    <section
      className="content-editor media-library"
      aria-labelledby="media-heading"
    >
      <div className="dashboard-section-heading">
        <div>
          <h2 id="media-heading">All photos</h2>
          <p>
            Every photo your site uses, and every one you have uploaded. Photos
            are stored privately; drop a new one in to add it to the library. To
            put a photo on a page, open that page and change the photo there.
          </p>
        </div>
      </div>
      <MediaDropzone
        busy={busy}
        uploadingFileName={uploadingFileName}
        uploadPending={uploadPending}
        chooseLabel="Upload a photo"
        onFiles={acceptFiles}
        onRetry={() => void upload()}
      />
      {assets.length > 0 || siteImages.length > 0 || deletionFinishing ? (
        <>
          <MediaGallery
            assets={assets}
            usage={usage}
            siteImages={siteImages}
            usedAssetIds={usedAssetIds}
            libraryToken={mediaLibraryToken}
            selectedAssetId={selectedAsset}
            disabled={busy}
            showUnusedPhotos
            deletingMessage={
              deletionFinishing
                ? "Finishing deletion of the last photo…"
                : undefined
            }
            onSelect={selectAsset}
          />
          {selectedPhoto === undefined ? null : (
            <article className="media-photo-detail">
              {mediaLibraryToken === undefined ? (
                <span
                  className="media-photo-detail-frame"
                  aria-hidden="true"
                />
              ) : (
                <img
                  alt=""
                  className="media-photo-detail-frame"
                  decoding="async"
                  src={mediaThumbnailUrl(
                    selectedPhoto.assetId,
                    mediaLibraryToken,
                  )}
                />
              )}
              <div className="media-photo-detail-body">
                <h3>{selectedPhoto.fileName}</h3>
                <p className="media-photo-detail-meta">
                  {selectedPhoto.width}×{selectedPhoto.height} ·{" "}
                  {photoSizeLabel(selectedPhoto.byteLength)}
                </p>
                <ul className="media-photo-uses">
                  {photoUsageBadges(selectedUse).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                <div className="media-asset-actions">
                  <button
                    className="copy-button"
                    type="button"
                    disabled={busy}
                    onClick={() => void deleteSelected()}
                  >
                    Delete selected photo
                  </button>
                </div>
              </div>
            </article>
          )}
        </>
      ) : (
        <p className="media-empty">
          No photos yet. Upload one above and it appears here.
        </p>
      )}
      <p role="status" aria-live="polite">{message}</p>
    </section>
  );
}
