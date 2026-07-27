import {
  AccessDeniedError,
  ContentRevisionConflictError,
  ContentRevisionIdempotencyError,
  ContentRevisionValidationError,
} from "@foundry/application";
import type { SiteDefinitionEdit } from "@foundry/site-definition";

import { AccessIdentityError } from "../../../../src/access-identity";
import { loadContentRevisionApplication } from "../../../../src/content-revision-runtime";
import {
  HumanAccessConfigurationError,
} from "../../../../src/human-access-configuration";
import {
  authorizeAuthenticatedHumanIdentity,
  loadHumanIdentityRequestContext,
} from "../../../../src/human-access-runtime";
import { verifyHumanMutation } from "../../../../src/human-mutation-runtime";
import { HumanRequestIntegrityError } from "../../../../src/human-request-integrity";

type SaveBody = {
  baseRevision: number;
  edits: SiteDefinitionEdit[];
};

function isSaveBody(value: unknown): value is SaveBody {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<SaveBody>;
  return (
    Number.isInteger(candidate.baseRevision) &&
    (candidate.baseRevision ?? -1) >= 0 &&
    Array.isArray(candidate.edits) &&
    candidate.edits.length > 0 &&
    candidate.edits.every(
      (edit) =>
        typeof edit === "object" &&
        edit !== null &&
        typeof edit.path === "string" &&
        typeof edit.value === "string",
    )
  );
}

export async function POST(request: Request) {
  try {
    const authenticated = await loadHumanIdentityRequestContext(
      request.headers,
    );
    await verifyHumanMutation(request, authenticated.identity);
    const access = await authorizeAuthenticatedHumanIdentity(authenticated);
    if (access.state !== "authorized") {
      throw new AccessDeniedError("membership_not_active");
    }
    const body: unknown = await request.json();
    if (!isSaveBody(body)) {
      return Response.json({ error: "invalid_command" }, { status: 400 });
    }
    const application = await loadContentRevisionApplication();
    const saved = await application.commands.save({
      actorId: access.membership.id,
      baseRevision: body.baseRevision,
      edits: body.edits,
      idempotencyKey: request.headers.get("idempotency-key") ?? "",
    });
    return Response.json(
      {
        ...saved,
        previewUrl: `/preview/${saved.revision}`,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof ContentRevisionValidationError) {
      return Response.json(
        { error: "validation_failed", fields: error.fields },
        { status: 422 },
      );
    }
    if (error instanceof ContentRevisionConflictError) {
      return Response.json(
        {
          error: "revision_conflict",
          currentRevision: error.currentRevision,
        },
        { status: 409 },
      );
    }
    if (error instanceof ContentRevisionIdempotencyError) {
      return Response.json(
        { error: "idempotency_key_conflict" },
        { status: 409 },
      );
    }
    if (
      error instanceof AccessIdentityError ||
      error instanceof AccessDeniedError ||
      error instanceof HumanRequestIntegrityError
    ) {
      return Response.json({ error: "request_check_failed" }, { status: 403 });
    }
    if (error instanceof HumanAccessConfigurationError) {
      return Response.json(
        { error: "request_check_unavailable" },
        { status: 503 },
      );
    }
    if (error instanceof SyntaxError) {
      return Response.json({ error: "invalid_command" }, { status: 400 });
    }
    throw error;
  }
}
