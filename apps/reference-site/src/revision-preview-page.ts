import "server-only";

import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";

import {
  AccessDeniedError,
  ContentRevisionBookmarkError,
  ContentRevisionConfigurationError,
  ContentWorkspaceAccessError,
  createContentActorId,
  createContentWorkspaceId,
  type ContentRevision,
} from "@humber-foundry/application";

import { AccessIdentityError } from "./access-identity";
import { loadContentRevisionApplication } from "./content-revision-runtime";
import { HumanAccessConfigurationError } from "./human-access-configuration";
import { loadMcpPreviewForHuman } from "./mcp-preview-review-runtime";
import {
  authorizeAuthenticatedHumanIdentity,
  loadHumanIdentityRequestContext,
} from "./human-access-runtime";
import { PreviewCapabilityError } from "./preview-capability";
import { verifyRevisionPreviewCapability } from "./preview-capability-runtime";

export type RevisionPreviewPageProps = {
  params: Promise<{ workspaceId: string; revision: string }>;
  searchParams: Promise<{
    capability?: string | string[];
    bookmark?: string | string[];
    accessToken?: string | string[];
    previewId?: string | string[];
  }>;
};

type RevisionPreview = ContentRevision & {
  mcpReview?: Readonly<{
    previewId: string;
    actorId: string;
    changedDocuments: ReadonlyArray<string>;
    designChanges: ReadonlyArray<string>;
    publicEffect: string;
  }>;
};

const loadSelectedRevision = cache(async function loadSelectedRevision(
  workspaceIdParameter: string,
  revisionParameter: string,
  capability: string,
  bookmark: string,
  previewId: string,
): Promise<RevisionPreview> {
  const revisionNumber = Number(revisionParameter);
  if (
    !Number.isSafeInteger(revisionNumber) ||
    revisionNumber < 0 ||
    String(revisionNumber) !== revisionParameter
  ) {
    notFound();
  }
  let workspaceId;
  try {
    workspaceId = createContentWorkspaceId(workspaceIdParameter);
  } catch {
    notFound();
  }
  try {
    const identity = await loadHumanIdentityRequestContext(await headers());
    const access = await authorizeAuthenticatedHumanIdentity(identity);
    if (access.state !== "authorized") {
      notFound();
    }
    await verifyRevisionPreviewCapability({
      capability,
      identity: access.identity,
      workspaceId,
      revision: revisionNumber,
    });
    if (previewId !== "") {
      const selected = await loadMcpPreviewForHuman({
        previewId,
        siteId: access.membership.siteId,
      });
      if (
        selected === null ||
        selected.revision.workspaceId !== workspaceId ||
        selected.revision.revision !== revisionNumber ||
        selected.revision.bookmark !== bookmark
      ) {
        notFound();
      }
      return { ...selected.revision, mcpReview: selected.review };
    }
    const application = await loadContentRevisionApplication(
      workspaceId,
      createContentActorId(access.membership.id),
    );
    const revision = await application.queries.getRevision(
      revisionNumber,
      bookmark,
    );
    if (
      revision === null ||
      revision.workspaceId !== workspaceId ||
      !(await application.queries.isRevisionCurrent(revision))
    ) {
      notFound();
    }
    return revision;
  } catch (error) {
    if (
      error instanceof AccessIdentityError ||
      error instanceof AccessDeniedError ||
      error instanceof HumanAccessConfigurationError ||
      error instanceof ContentRevisionConfigurationError ||
      error instanceof ContentRevisionBookmarkError ||
      error instanceof ContentWorkspaceAccessError ||
      error instanceof PreviewCapabilityError
    ) {
      notFound();
    }
    throw error;
  }
});

export async function loadRevisionPreview({
  params,
  searchParams,
}: RevisionPreviewPageProps) {
  const {
    workspaceId: workspaceIdParameter,
    revision: revisionParameter,
  } = await params;
  const { capability, bookmark, previewId } = await searchParams;
  if (typeof capability !== "string" || typeof bookmark !== "string") {
    notFound();
  }
  return loadSelectedRevision(
    workspaceIdParameter,
    revisionParameter,
    capability,
    bookmark,
    typeof previewId === "string" ? previewId : "",
  );
}
