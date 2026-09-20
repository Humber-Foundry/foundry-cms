import { AccessDeniedError } from "@humber-foundry/application";

import {
  AccessIdentityError,
  AccessIdentityUnavailableError,
} from "../../../../../src/access-identity";
import { HumanAccessConfigurationError } from "../../../../../src/human-access-configuration";
import {
  authorizeAuthenticatedHumanIdentity,
  loadHumanIdentityRequestContext,
} from "../../../../../src/human-access-runtime";
import { loadMcpPreviewForHuman } from "../../../../../src/mcp-preview-review-runtime";

/**
 * The answer depends on who is asking and on the draft as it stands right
 * now, so it is never stored. A cached answer would turn Approve on for a
 * preview that has since moved on, or keep it off after the draft settled.
 */
function answer(status: number) {
  return new Response(null, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
}

/**
 * Does this preview still stand?
 *
 * The review screen asks before it turns Approve on. The answer is a status
 * and no body: `204` while the stored revision is still current and still
 * hashes to the artifact the app prepared, `404` once it is not.
 *
 * This is a read. It records nothing and it approves nothing, which is why it
 * may be a `GET`. Recording a decision is a `POST` on the parent route.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ previewId: string }> },
) {
  try {
    const identity = await loadHumanIdentityRequestContext(
      new Headers(_request.headers),
    );
    const access = await authorizeAuthenticatedHumanIdentity(identity);
    if (access.state !== "authorized") {
      return answer(403);
    }
    const { previewId } = await params;
    const selected = await loadMcpPreviewForHuman({
      previewId,
      siteId: access.membership.siteId,
    });
    return answer(selected === null ? 404 : 204);
  } catch (error) {
    if (
      error instanceof AccessDeniedError ||
      error instanceof AccessIdentityError
    ) {
      return answer(403);
    }
    if (
      error instanceof AccessIdentityUnavailableError ||
      error instanceof HumanAccessConfigurationError
    ) {
      return answer(503);
    }
    throw error;
  }
}
