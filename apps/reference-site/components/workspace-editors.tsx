"use client";

import { useCallback, useState } from "react";

import type {
  ContentRevision,
  MediaAsset,
} from "@foundry/application";

import { ContentEditor } from "./content-editor";
import { MediaManager } from "./media-manager";
import type { MediaOccurrenceState } from "./media-manager-state";
import { advanceWorkspaceRevisionHead } from "./workspace-revision";

export function WorkspaceEditors({
  csrfToken,
  contentRevision: initialContentRevision,
  initialPreviewUrl,
  initialContentStale,
  activeWorkspaceUrl,
  staleRecovery,
  mediaAssets,
  mediaOccurrences,
}: {
  csrfToken: string;
  contentRevision: ContentRevision;
  initialPreviewUrl: string;
  initialContentStale?: boolean;
  activeWorkspaceUrl: string;
  staleRecovery?: Readonly<{ id: string; sourceWorkspaceId: string }>;
  mediaAssets: ReadonlyArray<MediaAsset>;
  mediaOccurrences: ReadonlyArray<MediaOccurrenceState>;
}) {
  const [head, setHead] = useState({
    revision: initialContentRevision,
    previewUrl: initialPreviewUrl,
  });
  const advanceRevisionHead = useCallback(
    (incoming: ContentRevision, previewUrl: string) => {
      setHead((current) =>
        advanceWorkspaceRevisionHead(current, incoming, previewUrl),
      );
    },
    [],
  );
  return (
    <>
      <ContentEditor
        csrfToken={csrfToken}
        initialRevision={initialContentRevision}
        revisionHead={head.revision}
        revisionHeadPreviewUrl={head.previewUrl}
        onRevisionSaved={advanceRevisionHead}
        initialPreviewUrl={initialPreviewUrl}
        initialStale={initialContentStale}
        activeWorkspaceUrl={activeWorkspaceUrl}
        staleRecovery={staleRecovery}
      />
      <MediaManager
        csrfToken={csrfToken}
        initialAssets={mediaAssets}
        initialOccurrences={mediaOccurrences}
        contentRevision={head.revision}
        contentStale={initialContentStale === true}
        onRevisionSaved={advanceRevisionHead}
      />
    </>
  );
}
