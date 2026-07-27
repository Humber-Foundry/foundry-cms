import type { ContentWorkspaceId } from "@foundry/application";

export function revisionPreviewGatewayUrl(
  workspaceId: ContentWorkspaceId,
  revision: number,
): string {
  const query = new URLSearchParams({
    workspaceId,
    revision: String(revision),
  });
  return `/api/foundry-cms/revisions?${query.toString()}`;
}
