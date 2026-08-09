"use client";

import { useCallback, useState } from "react";

import type {
  ContentRevision,
  MediaAsset,
} from "@humber-foundry/application";
import type { BlogPostId } from "@humber-foundry/site-definition";

import { ContentEditor } from "./content-editor";
import { MediaManager } from "./media-manager";
import type { MediaOccurrenceState } from "./media-manager-state";
import { advanceWorkspaceRevisionHead } from "./workspace-revision";
import { BlogPostControls } from "./blog-post-controls";

export function WorkspaceEditors({
  csrfToken,
  contentRevision: initialContentRevision,
  initialPreviewUrl,
  initialContentStale,
  activeWorkspaceUrl,
  staleRecovery,
  mediaAssets,
  mediaOccurrences,
  mediaWorkspaceId,
  verifiedPublicPostIds,
}: {
  csrfToken: string;
  contentRevision: ContentRevision;
  initialPreviewUrl: string;
  initialContentStale?: boolean;
  activeWorkspaceUrl: string;
  staleRecovery?: Readonly<{ id: string; sourceWorkspaceId: string }>;
  mediaAssets: ReadonlyArray<MediaAsset>;
  mediaOccurrences: ReadonlyArray<MediaOccurrenceState>;
  mediaWorkspaceId: string;
  verifiedPublicPostIds: ReadonlyArray<BlogPostId>;
}) {
  const [head, setHead] = useState({
    revision: initialContentRevision,
    previewUrl: initialPreviewUrl,
  });
  const [contentStale, setContentStale] = useState(
    initialContentStale === true,
  );
  const [mediaAccessToken, setMediaAccessToken] = useState<string>();
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
        onContentStale={() => setContentStale(true)}
        initialPreviewUrl={initialPreviewUrl}
        initialStale={initialContentStale}
        activeWorkspaceUrl={activeWorkspaceUrl}
        staleRecovery={staleRecovery}
        mediaAccessToken={mediaAccessToken}
      />
      <MediaManager
        csrfToken={csrfToken}
        workspaceId={mediaWorkspaceId}
        initialAssets={mediaAssets}
        initialOccurrences={mediaOccurrences}
        contentRevision={head.revision}
        contentStale={contentStale}
        onRevisionSaved={advanceRevisionHead}
        onContentStale={() => setContentStale(true)}
        onAccessGranted={setMediaAccessToken}
      />
      <BlogPostControls
        revision={head.revision}
        csrfToken={csrfToken}
        verifiedPublicPostIds={verifiedPublicPostIds}
      />
    </>
  );
}
