"use client";

import { useRef, useState } from "react";

import type {
  ContentRevision,
  MediaAsset,
  MediaOccurrenceRevision,
} from "@foundry/application";
import { renderedMediaOccurrenceIds } from "@foundry/application";
import { requireRenderedMediaOccurrenceId } from "@foundry/application";

import { MediaOccurrence } from "./media-occurrence";
import {
  cropForOccurrence,
  cropForSelectedRevision,
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

export function MediaManager({
  csrfToken,
  initialAssets,
  initialOccurrences,
  contentRevision,
  onRevisionSaved,
}: {
  csrfToken: string;
  initialAssets: ReadonlyArray<MediaAsset>;
  initialOccurrences: ReadonlyArray<MediaOccurrenceRevision>;
  contentRevision?: ContentRevision;
  onRevisionSaved(revision: ContentRevision, previewUrl: string): void;
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
  const [mutationToken, setMutationToken] = useState(csrfToken);
  const selectedOccurrenceId = useRef(occurrenceId);
  const uploadAttempt = useRef<MediaUploadAttempt | null>(null);
  const replaceAttempt = useRef<JsonAttempt | null>(null);
  const cropAttempt = useRef<JsonAttempt | null>(null);
  const deleteAttempt = useRef<JsonAttempt | null>(null);

  type JsonAttempt = Readonly<{ body: unknown; idempotencyKey: string }>;

  async function mutateJson(attempt: JsonAttempt) {
    const result = await sendMediaMutationAttempt({
      attempt: {
        body: JSON.stringify(attempt.body),
        contentType: "application/json",
        idempotencyKey: attempt.idempotencyKey,
      },
      mutationToken,
    });
    setMutationToken(result.mutationToken);
    if (!result.response.ok) throw new Error("media_mutation_failed");
    return result.body;
  }

  async function upload(file?: File) {
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
        mutationToken,
      });
      setMutationToken(result.mutationToken);
      if (!result.response.ok) throw new Error("media_upload_failed");
      const asset = result.body as MediaAsset;
      uploadAttempt.current = mediaUploadAttemptAfterResult(attempt, true);
      setUploadPending(false);
      setAssets((current) => [...current, asset]);
      setSelectedAsset(asset.assetId);
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
      setBusy(false);
    }
  }

  async function replaceSelected() {
    const current = occurrences.find(
      (occurrence) => occurrence.occurrenceId === occurrenceId,
    );
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
        occurrence: MediaOccurrenceRevision;
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
      onRevisionSaved(result.contentRevision, result.previewUrl);
      setPreviewUrl(result.previewUrl);
      setMessage("Only the selected occurrence was replaced.");
    } catch {
      setMessage("The occurrence changed elsewhere or could not be replaced.");
    } finally {
      setBusy(false);
    }
  }

  async function cropSelected() {
    const current = occurrences.find(
      (occurrence) => occurrence.occurrenceId === occurrenceId,
    );
    if (current === undefined || contentRevision === undefined) return;
    setBusy(true);
    try {
      cropAttempt.current ??= {
        idempotencyKey: crypto.randomUUID(),
        body: {
          operation: "crop",
          occurrenceId,
          baseRevision: current.revision,
          crop,
          workspaceId: contentRevision.workspaceId,
          contentBaseRevision: contentRevision.revision,
        },
      };
      const result = (await mutateJson(cropAttempt.current)) as {
        occurrence: MediaOccurrenceRevision;
        contentRevision: ContentRevision;
        previewUrl: string;
      };
      const revision = result.occurrence;
      setOccurrences((items) => [
        ...items.filter((item) => item.occurrenceId !== occurrenceId),
        revision,
      ]);
      cropAttempt.current = null;
      onRevisionSaved(result.contentRevision, result.previewUrl);
      setPreviewUrl(result.previewUrl);
      setMessage("Crop saved as revision data; the source is unchanged.");
    } catch {
      setMessage("The crop could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelected() {
    if (selectedAsset === "") return;
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
      setSelectedAsset(remaining[0]?.assetId ?? "");
      setMessage("Unused source and metadata deleted.");
    } catch {
      setMessage(
        "This asset is still referenced by revision history and cannot be deleted.",
      );
    } finally {
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
            accept="image/jpeg,image/png,image/webp,image/avif"
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
      {assets.length > 0 ? (
        <div className="editor-fields">
          <label>
            Occurrence ID
            <select
              value={occurrenceId}
              onChange={(event) => {
                replaceAttempt.current = null;
                cropAttempt.current = null;
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
              value={selectedAsset}
              onChange={(event) => {
                replaceAttempt.current = null;
                deleteAttempt.current = null;
                setSelectedAsset(event.target.value);
              }}
            >
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
                contentRevision === undefined ||
                occurrenceId === "" ||
                selectedAsset === ""
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
                contentRevision === undefined ||
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
                  min={field === "width" || field === "height" ? 0.01 : 0}
                  max={1}
                  step={0.01}
                  value={crop[field]}
                  onChange={(event) =>
                    {
                      cropAttempt.current = null;
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
            if (asset === undefined) return null;
            return (
              <MediaOccurrence
                key={occurrence.occurrenceId}
                occurrence={{
                  occurrenceId: requireRenderedMediaOccurrenceId(
                    occurrence.occurrenceId,
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
              >
              <figcaption>
                {occurrence.occurrenceId} · revision {occurrence.revision}
              </figcaption>
              </MediaOccurrence>
            );
          })}
          {previewUrl === undefined ? null : (
            <p>
              <a href={previewUrl}>Preview this exact media revision</a>
            </p>
          )}
        </div>
      ) : (
        <p>Upload an image to create the first stable media asset.</p>
      )}
      <p role="status" aria-live="polite">{message}</p>
    </section>
  );
}
