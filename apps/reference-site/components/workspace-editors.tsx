"use client";

import { useCallback, useState } from "react";

import type {
  ContentRevision,
  MediaAsset,
  MediaOccurrenceRevision,
} from "@foundry/application";

import { ContentEditor } from "./content-editor";
import { MediaManager } from "./media-manager";
import { newestContentRevision } from "./workspace-revision";

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
  mediaOccurrences: ReadonlyArray<MediaOccurrenceRevision>;
}) {
  const [revisionHead, setRevisionHead] = useState(initialContentRevision);
  const advanceRevisionHead = useCallback((incoming: ContentRevision) => {
    setRevisionHead((current) =>
      newestContentRevision(current, incoming),
    );
  }, []);
  return (
    <>
      <ContentEditor
        csrfToken={csrfToken}
        initialRevision={initialContentRevision}
        revisionHead={revisionHead}
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
        contentRevision={revisionHead}
        onRevisionSaved={advanceRevisionHead}
      />
    </>
  );
}
