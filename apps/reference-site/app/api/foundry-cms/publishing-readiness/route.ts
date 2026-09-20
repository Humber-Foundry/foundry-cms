import { AccessDeniedError } from "@humber-foundry/application";

import {
  AccessIdentityError,
  AccessIdentityUnavailableError,
} from "../../../../src/access-identity";
import { readContentPublicationReadiness } from "../../../../src/content-publication-runtime";
import { HumanAccessConfigurationError } from "../../../../src/human-access-configuration";
import {
  authorizeAuthenticatedHumanIdentity,
  loadHumanIdentityRequestContext,
} from "../../../../src/human-access-runtime";
import { HumanRequestIntegrityError } from "../../../../src/human-request-integrity";

/**
 * Whether site publishing is connected, for the screens where a site owner
 * does the work: Blog, Pages and Settings. It never returns a setting's
 * value, a token or a key — see `content-publication-readiness.ts`.
 */
export async function GET(request: Request) {
  try {
    const identity = await loadHumanIdentityRequestContext(request.headers);
    const access = await authorizeAuthenticatedHumanIdentity(identity);
    if (access.state !== "authorized") {
      throw new AccessDeniedError("membership_not_active");
    }
    return Response.json(
      { publishing: await readContentPublicationReadiness() },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    if (
      error instanceof AccessDeniedError ||
      error instanceof AccessIdentityError ||
      error instanceof HumanRequestIntegrityError
    ) {
      return Response.json({ error: "request_check_failed" }, { status: 403 });
    }
    if (
      error instanceof AccessIdentityUnavailableError ||
      error instanceof HumanAccessConfigurationError
    ) {
      return Response.json(
        { error: "request_check_unavailable" },
        { status: 503 },
      );
    }
    throw error;
  }
}
