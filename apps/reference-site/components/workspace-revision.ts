import type { ContentRevision } from "@foundry/application";

export function newestContentRevision(
  current: ContentRevision,
  incoming: ContentRevision,
) {
  return current.revision >= incoming.revision ? current : incoming;
}

export type WorkspaceRevisionHead = Readonly<{
  revision: ContentRevision;
  previewUrl: string;
}>;

export function advanceWorkspaceRevisionHead(
  current: WorkspaceRevisionHead,
  incoming: ContentRevision,
  previewUrl: string,
): WorkspaceRevisionHead {
  return current.revision.revision >= incoming.revision
    ? current
    : { revision: incoming, previewUrl };
}
