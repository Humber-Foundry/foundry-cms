import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { AccessDeniedError } from "@humber-foundry/application";

import { AccessIdentityError } from "@/src/access-identity";
import { HumanAccessConfigurationError } from "@/src/human-access-configuration";
import { loadHumanAccessRequestContext } from "@/src/human-access-runtime";
import { loadMcpPreviewForHuman } from "@/src/mcp-preview-review-runtime";
import { createHumanMediaAccessToken } from "@/src/human-mutation-runtime";
import { createRevisionPreviewCapability } from "@/src/preview-capability-runtime";


export const dynamic = "force-dynamic";
export const metadata = {
  robots: { index: false, follow: false },
  title: "MCP draft review",
};

export default async function McpPreviewReviewPage({
  params,
}: {
  params: Promise<{ previewId: string }>;
}) {
  let access;
  try {
    access = await loadHumanAccessRequestContext(await headers());
  } catch (error) {
    if (
      error instanceof AccessIdentityError ||
      error instanceof AccessDeniedError ||
      error instanceof HumanAccessConfigurationError
    ) {
      notFound();
    }
    throw error;
  }
  if (access.state !== "authorized") notFound();
  const { previewId } = await params;
  const selected = await loadMcpPreviewForHuman({
    previewId,
    siteId: access.membership.siteId,
  });
  if (selected === null) notFound();
  const { revision } = selected;
  const capability = await createRevisionPreviewCapability({
    identity: access.identity,
    workspaceId: revision.workspaceId,
    revision: revision.revision,
  });
  const media = await createHumanMediaAccessToken(
    access.identity,
    (revision.definition.home.media ?? []).map(
      ({ asset }) => asset.assetId,
    ),
    new Date().toISOString(),
  );
  const query = new URLSearchParams({
    capability,
    bookmark: revision.bookmark,
    accessToken: media.token,
    previewId,
  });
  redirect(
    `/__foundry/preview/${revision.workspaceId}/${revision.revision}` +
      `?${query.toString()}`,
  );
}
