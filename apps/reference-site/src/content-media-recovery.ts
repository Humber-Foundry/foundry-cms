import type { ContentRevision } from "@foundry/application";
import {
  isSiteDefinition,
  type SiteDefinition,
  type SiteMediaOccurrence,
} from "@foundry/site-definition";

import type { StaleRecoveryEdit } from "./content-editor-recovery";
import { mediaManifestRecoveryPath } from "./content-schema-recovery";
import {
  sendMediaMutationAttempt,
  type MediaMutationAttempt,
} from "./media-mutation-client";

type CreatedWorkspace = Readonly<{
  workspaceId: string;
  revision: ContentRevision["revision"];
  definition: SiteDefinition;
}>;

type MediaRecoverySender = (
  attempt: MediaMutationAttempt,
  mutationToken: string,
) => Promise<Readonly<{
  response: Pick<Response, "ok">;
  body: unknown;
  mutationToken: string;
}>>;

type MediaRecoveryPlan =
  | Readonly<{
      operation: "replace";
      target: SiteMediaOccurrence;
    }>
  | Readonly<{
      operation: "resume-crop";
      target: SiteMediaOccurrence;
    }>;

function parseMediaRecoveryManifest(
  encoded: string,
  definition: SiteDefinition,
): ReadonlyArray<SiteMediaOccurrence> {
  const media: unknown = JSON.parse(encoded);
  const candidate = {
    ...definition,
    home: { ...definition.home, media },
  };
  if (!isSiteDefinition(candidate)) {
    throw new Error("content_media_recovery_invalid");
  }
  return candidate.home.media ?? [];
}

function sameCrop(
  left: SiteMediaOccurrence["crop"],
  right: SiteMediaOccurrence["crop"],
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.x === right.x &&
      left.y === right.y &&
      left.width === right.width &&
      left.height === right.height)
  );
}

function sameMediaBinding(
  left: SiteMediaOccurrence | undefined,
  right: SiteMediaOccurrence | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.occurrenceId === right.occurrenceId &&
      left.asset.assetId === right.asset.assetId &&
      left.asset.width === right.asset.width &&
      left.asset.height === right.asset.height &&
      left.asset.contentType === right.asset.contentType &&
      sameCrop(left.crop, right.crop))
  );
}

function mediaMutationRevisions(
  result: Awaited<ReturnType<MediaRecoverySender>>,
  requireOccurrence: boolean,
): Readonly<{
  contentRevision: number;
  occurrenceRevision?: number;
}> {
  if (
    !result.response.ok ||
    typeof result.body !== "object" ||
    result.body === null ||
    !("contentRevision" in result.body) ||
    typeof result.body.contentRevision !== "object" ||
    result.body.contentRevision === null ||
    !("revision" in result.body.contentRevision) ||
    typeof result.body.contentRevision.revision !== "number"
  ) {
    throw new Error("content_media_recovery_failed");
  }
  if (!requireOccurrence) {
    return { contentRevision: result.body.contentRevision.revision };
  }
  if (
    !("occurrence" in result.body) ||
    typeof result.body.occurrence !== "object" ||
    result.body.occurrence === null ||
    !("revision" in result.body.occurrence) ||
    typeof result.body.occurrence.revision !== "number"
  ) {
    throw new Error("content_media_recovery_failed");
  }
  return {
    contentRevision: result.body.contentRevision.revision,
    occurrenceRevision: result.body.occurrence.revision,
  };
}

export async function restorePreservedMedia({
  edit,
  created,
  mutationToken,
  idempotencyKey,
  send = (attempt, token) =>
    sendMediaMutationAttempt({ attempt, mutationToken: token }),
  onMutationToken = () => undefined,
}: {
  edit: StaleRecoveryEdit | undefined;
  created: CreatedWorkspace;
  mutationToken: string;
  idempotencyKey: string;
  send?: MediaRecoverySender;
  onMutationToken?: (token: string) => void;
}): Promise<string> {
  if (edit === undefined) {
    return mutationToken;
  }
  if (edit.path !== mediaManifestRecoveryPath) {
    throw new Error("content_media_recovery_invalid");
  }
  const baseMedia = parseMediaRecoveryManifest(
    edit.baseValue,
    created.definition,
  );
  const targetMedia = parseMediaRecoveryManifest(
    edit.value,
    created.definition,
  );
  const currentMedia = created.definition.home.media ?? [];
  const baseById = new Map(
    baseMedia.map((occurrence) => [occurrence.occurrenceId, occurrence]),
  );
  const currentById = new Map(
    currentMedia.map((occurrence) => [occurrence.occurrenceId, occurrence]),
  );
  const targetIds = new Set(
    targetMedia.map(({ occurrenceId }) => occurrenceId),
  );
  if (
    baseMedia.some(({ occurrenceId }) => !targetIds.has(occurrenceId)) ||
    currentMedia.some(
      ({ occurrenceId }) =>
        !baseById.has(occurrenceId) && !targetIds.has(occurrenceId),
    )
  ) {
    throw new Error("content_media_recovery_removal_unsupported");
  }
  const plan: MediaRecoveryPlan[] = [];
  for (const occurrence of targetMedia) {
    const base = baseById.get(occurrence.occurrenceId);
    const current = currentById.get(occurrence.occurrenceId);
    if (sameMediaBinding(current, occurrence)) {
      continue;
    }
    const targetChanged = !sameMediaBinding(base, occurrence);
    if (!targetChanged) {
      continue;
    }
    const replaceAlreadyApplied =
      current !== undefined &&
      occurrence.crop !== null &&
      current.occurrenceId === occurrence.occurrenceId &&
      current.asset.assetId === occurrence.asset.assetId &&
      current.asset.width === occurrence.asset.width &&
      current.asset.height === occurrence.asset.height &&
      current.asset.contentType === occurrence.asset.contentType &&
      current.crop === null;
    if (replaceAlreadyApplied) {
      plan.push({
        operation: "resume-crop",
        target: occurrence,
      });
      continue;
    }
    if (!sameMediaBinding(current, base)) {
      throw new Error("content_media_recovery_conflict");
    }
    plan.push({ operation: "replace", target: occurrence });
  }

  let contentRevision = created.revision;
  for (const step of plan) {
    const occurrence = step.target;
    if (step.operation === "resume-crop") {
      const replacementProof = await send(
        {
          contentType: "application/json",
          idempotencyKey:
            `${idempotencyKey}:media:${occurrence.occurrenceId}:replace`,
          body: JSON.stringify({
            operation: "replace",
            occurrenceId: occurrence.occurrenceId,
            assetId: occurrence.asset.assetId,
            baseRevision: 0,
            workspaceId: created.workspaceId,
            contentBaseRevision: contentRevision,
          }),
        },
        mutationToken,
      );
      mutationToken = replacementProof.mutationToken;
      onMutationToken(mutationToken);
      const provenReplacement = mediaMutationRevisions(
        replacementProof,
        true,
      );
      contentRevision = provenReplacement.contentRevision;
      const crop = await send(
        {
          contentType: "application/json",
          idempotencyKey:
            `${idempotencyKey}:media:${occurrence.occurrenceId}:crop`,
          body: JSON.stringify({
            operation: "crop",
            occurrenceId: occurrence.occurrenceId,
            baseRevision: provenReplacement.occurrenceRevision,
            workspaceId: created.workspaceId,
            contentBaseRevision: contentRevision,
            crop: occurrence.crop,
          }),
        },
        mutationToken,
      );
      mutationToken = crop.mutationToken;
      onMutationToken(mutationToken);
      contentRevision =
        mediaMutationRevisions(crop, false).contentRevision;
      continue;
    }
    const replace = await send(
      {
        contentType: "application/json",
        idempotencyKey:
          `${idempotencyKey}:media:${occurrence.occurrenceId}:replace`,
        body: JSON.stringify({
          operation: "replace",
          occurrenceId: occurrence.occurrenceId,
          assetId: occurrence.asset.assetId,
          baseRevision: 0,
          workspaceId: created.workspaceId,
          contentBaseRevision: contentRevision,
        }),
      },
      mutationToken,
    );
    mutationToken = replace.mutationToken;
    onMutationToken(mutationToken);
    const replaced = mediaMutationRevisions(replace, true);
    contentRevision = replaced.contentRevision;
    if (occurrence.crop === null) {
      continue;
    }
    const crop = await send(
      {
        contentType: "application/json",
        idempotencyKey:
          `${idempotencyKey}:media:${occurrence.occurrenceId}:crop`,
        body: JSON.stringify({
          operation: "crop",
          occurrenceId: occurrence.occurrenceId,
          baseRevision: replaced.occurrenceRevision,
          workspaceId: created.workspaceId,
          contentBaseRevision: contentRevision,
          crop: occurrence.crop,
        }),
      },
      mutationToken,
    );
    mutationToken = crop.mutationToken;
    onMutationToken(mutationToken);
    contentRevision =
      mediaMutationRevisions(crop, false).contentRevision;
  }
  return mutationToken;
}
