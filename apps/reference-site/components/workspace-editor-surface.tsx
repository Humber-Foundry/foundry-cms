"use client";

import { useCallback, useState } from "react";

import type { ContentRevision } from "@humber-foundry/application";

import {
  ContentEditor,
  designFieldGroups,
  pageFieldGroups,
} from "./content-editor";
import { advanceWorkspaceRevisionHead } from "./workspace-revision";

/**
 * The editing surface Pages and Design share. Both destinations edit the same
 * revision through the same save and publish controls; they differ only in
 * which part of it they put in front of the owner — Pages shows the canvas and
 * the site-wide text fields, Design shows the design tokens.
 *
 * The surface holds the revision head so the editor keeps working across
 * saves without a reload.
 */
const variants = {
  pages: {
    heading: "Pages",
    fieldGroups: pageFieldGroups,
    showComposition: true,
    showPublicationHistory: true,
  },
  design: {
    heading: "Design choices",
    fieldGroups: designFieldGroups,
    showComposition: false,
    showPublicationHistory: false,
  },
} as const;

export function WorkspaceEditorSurface({
  variant,
  csrfToken,
  contentRevision,
  initialPreviewUrl,
  initialContentStale,
  activeWorkspaceUrl,
  staleRecovery,
}: {
  variant: keyof typeof variants;
  csrfToken: string;
  contentRevision: ContentRevision;
  initialPreviewUrl: string;
  initialContentStale?: boolean;
  activeWorkspaceUrl: string;
  staleRecovery?: Readonly<{ id: string; sourceWorkspaceId: string }>;
}) {
  const [head, setHead] = useState({
    revision: contentRevision,
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
    <ContentEditor
      csrfToken={csrfToken}
      initialRevision={contentRevision}
      revisionHead={head.revision}
      revisionHeadPreviewUrl={head.previewUrl}
      onRevisionSaved={advanceRevisionHead}
      initialPreviewUrl={initialPreviewUrl}
      initialStale={initialContentStale}
      activeWorkspaceUrl={activeWorkspaceUrl}
      staleRecovery={staleRecovery}
      {...variants[variant]}
    />
  );
}
