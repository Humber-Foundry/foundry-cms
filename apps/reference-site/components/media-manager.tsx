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
    contentRevision,
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
            contentRevision?.definition.home.media ?? [],
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
      setMessage("Source stored in client-owned media.");
    } catch {
      if (uploadAttempt.current !== null) {
        uploadAttempt.current = mediaUploadAttemptAfterResult(
          uploadAttempt.current,
          false,
        );
        setUploadPending(true);
      }
      setMessage(
        "The upload result could not be confirmed. Retry the same upload.",
      );
    } finally {
      finishCatalogMutation();
      setBusy(false);
    }
  }

  async function replaceSelected() {
    if (!occurrenceMutationsEnabled) return;
    const current = occurrences.find(
      (occurrence) => occurrence.occurrenceId === occurrenceId,
    );
    beginCatalogMutation();
    setBusy(true);
    try {
    if (contentRevision === undefined) return;
    replaceAttempt.current ??= {
      idempotencyKey: crypto.randomUUID(),
      body: {
        operation: "replace",
        occurrenceId,
        assetId: selectedAsset,
        baseRevision: current?.revision ?? 0,
        workspaceId: contentRevision.workspaceId,
        contentBaseRevision: contentRevision.revision,
      },
    };
    const result = (await mutateJson(replaceAttempt.current)) as {
        occurrence: MediaOccurrenceState;
        contentRevision: ContentRevision;
        previewUrl: string;
      };
      const revision = result.occurrence;
      setOccurrences((items) => [
        ...items.filter((item) => item.occurrenceId !== occurrenceId),
        revision,
      ]);
      const nextCrop = cropForSelectedRevision(
        selectedOccurrenceId.current,
        revision,
      );
      if (nextCrop !== undefined) setCrop(nextCrop);
      replaceAttempt.current = null;
      cropBaseRevision.current = null;
      onRevisionSaved(result.contentRevision, result.previewUrl);
      setPreviewUrl(result.previewUrl);
      setMessage("Only the selected occurrence was replaced.");
    } catch (error) {
      replaceAttempt.current = mediaOccurrenceAttemptAfterFailure(
        replaceAttempt.current,
        error instanceof MediaMutationRequestError
          ? error.response.status
          : undefined,
        error instanceof MediaMutationRequestError ? error.body : undefined,
      );
      setMessage("The occurrence changed elsewhere or could not be replaced.");
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
      contentRevision === undefined ||
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
          workspaceId: contentRevision.workspaceId,
          contentBaseRevision: contentRevision.revision,
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
      onRevisionSaved(result.contentRevision, result.previewUrl);
      setPreviewUrl(result.previewUrl);
      setMessage("Crop saved as revision data; the source is unchanged.");
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
      setMessage("The crop could not be saved.");
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
      setMessage("Unused source and metadata deleted.");
    } catch (error) {
      setMessage(
        error instanceof MediaMutationRequestError
          ? mediaDeleteFailureMessage(
              error.body,
              error.response.headers.get("retry-after"),
            )
          : "The asset could not be deleted. Retry the same request.",
      );
    } finally {
      finishCatalogMutation();
      setBusy(false);
    }
  }

  return (
    <section className="content-editor" aria-labelledby="media-heading">
      <div className="dashboard-section-heading">
        <div>
          <h2 id="media-heading">Media</h2>
          <p>Private source images with occurrence-local replacements and crops.</p>
        </div>
        <label className="button button-secondary">
          {busy ? "Working…" : "Upload image"}
          <input
            hidden
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={busy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file !== undefined) void upload(file);
            }}
          />
        </label>
        {uploadPending ? (
          <button
            className="button button-secondary"
            type="button"
            disabled={busy}
            onClick={() => void upload()}
          >
            Retry same upload
          </button>
        ) : null}
      </div>
      {assets.length > 0 || deleteAttempt.current !== null ? (
        <div className="editor-fields">
          <label>
            Occurrence ID
            <select
              disabled={busy}
              value={occurrenceId}
              onChange={(event) => {
                replaceAttempt.current = null;
                cropAttempt.current = null;
                cropBaseRevision.current = null;
                const nextOccurrenceId = event.target.value;
                selectedOccurrenceId.current = nextOccurrenceId;
                setOccurrenceId(nextOccurrenceId);
                setCrop(cropForOccurrence(occurrences, nextOccurrenceId));
              }}
            >
              {renderedMediaOccurrenceIds.map((id) => (
                <option key={id} value={id}>
                  {id === "occurrence_home_hero"
                    ? "Home hero image"
                    : "Home detail image"}
                </option>
              ))}
            </select>
          </label>
          <label>
            Source asset
            <select
              disabled={busy}
              value={selectedAsset}
              onChange={(event) => {
                selectAsset(event.target.value);
              }}
            >
              {deleteAttempt.current !== null &&
              !assets.some((asset) => asset.assetId === selectedAsset) ? (
                <option value={selectedAsset}>
                  Finishing deletion of {selectedAsset}
                </option>
              ) : null}
              {assets.map((asset) => (
                <option key={asset.assetId} value={asset.assetId}>
                  {asset.fileName} · {asset.width}×{asset.height}
                </option>
              ))}
            </select>
          </label>
          <div className="editor-actions">
            <button
              className="button button-primary"
              type="button"
              disabled={
                busy ||
                !occurrenceMutationsEnabled ||
                occurrenceId === "" ||
                selectedAsset === "" ||
                !assets.some((asset) => asset.assetId === selectedAsset)
              }
              onClick={() => void replaceSelected()}
            >
              Use in selected occurrence
            </button>
            <button
              className="button button-secondary"
              type="button"
              disabled={
                busy ||
                !occurrenceMutationsEnabled ||
                !occurrences.some(
                  (occurrence) => occurrence.occurrenceId === occurrenceId,
                )
              }
              onClick={() => void cropSelected()}
            >
              Apply inset crop
            </button>
            <button
              className="button button-secondary"
              type="button"
              disabled={busy || selectedAsset === ""}
              onClick={() => void deleteSelected()}
            >
              Delete unused asset
            </button>
          </div>
          <fieldset>
            <legend>Normalized crop</legend>
            {(["x", "y", "width", "height"] as const).map((field) => (
              <label key={field}>
                {field}
                <input
                  type="number"
                  disabled={busy}
                  min={field === "width" || field === "height" ? 0.01 : 0}
                  max={1}
                  step={0.01}
                  value={crop[field]}
                  onChange={(event) =>
                    {
                      cropAttempt.current = null;
                      const currentRevision =
                        occurrences.find(
                          (occurrence) =>
                            occurrence.occurrenceId === occurrenceId,
                        )?.revision ?? 0;
                      cropBaseRevision.current = cropBaseRevisionForEdit(
                        cropBaseRevision.current,
                        currentRevision,
                      );
                      setCrop((current) => ({
                        ...current,
                        [field]: Number(event.target.value),
                      }));
                    }
                  }
                />
              </label>
            ))}
          </fieldset>
          {occurrences.map((occurrence) => {
            const asset = assets.find(
              (candidate) => candidate.assetId === occurrence.assetId,
            );
            if (asset === undefined || mediaAccessToken === undefined) {
              return null;
            }
            return (
              <MediaOccurrence
                key={occurrence.occurrenceId}
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
              >
              <figcaption>
                {occurrence.occurrenceId} · revision {occurrence.revision}
              </figcaption>
              </MediaOccurrence>
            );
          })}
          {previewUrl === undefined ? null : (
            <p>
              <a
                href={`${previewUrl}&accessToken=${encodeURIComponent(
                  mediaAccessToken ?? "",
                )}`}
              >
                Preview this exact media revision
              </a>
            </p>
          )}
        </div>
      ) : (
        <p>Upload an image to create the first stable media asset.</p>
      )}
      {contentStale ? (
        <p>
          Start a fresh workspace before replacing or cropping an occurrence.
          Site-level uploads and deletion of unused assets remain available.
        </p>
      ) : null}
      <p role="status" aria-live="polite">{message}</p>
    </section>
  );
}
