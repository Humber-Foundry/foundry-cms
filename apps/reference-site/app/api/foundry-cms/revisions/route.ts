import {
  AccessDeniedError,
  ContentRevisionConflictError,
  ContentRevisionIdempotencyError,
  ContentRevisionValidationError,
  ContentRevisionConfigurationError,
  ContentRevisionStaleError,
  ContentWorkspaceAccessError,
  createContentWorkspaceId,
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
import { createRevisionPreviewCapability } from "../../../../src/preview-capability-runtime";

type SaveBody = {
  workspaceId: ReturnType<typeof createContentWorkspaceId>;
  schemaVersion: "1.0.0";
  baseRevision: number;
  edits: SiteDefinitionEdit[];
};

function parseSaveBody(
  value: unknown,
):
  | Readonly<{ ok: true; body: SaveBody }>
  | Readonly<{ ok: false; fields?: Readonly<Record<string, string>> }> {
  if (typeof value !== "object" || value === null) {
    return { ok: false };
  }
  const candidate = value as Record<string, unknown>;
  if (
    !Number.isInteger(candidate.baseRevision) ||
    (candidate.baseRevision as number) < 0 ||
    typeof candidate.workspaceId !== "string" ||
    typeof candidate.schemaVersion !== "string" ||
    !Array.isArray(candidate.edits) ||
    candidate.edits.length === 0
  ) {
    return { ok: false };
  }
  const errors: Record<string, string> = {};
  const edits: SiteDefinitionEdit[] = [];
  candidate.edits.forEach((edit, index) => {
    if (typeof edit !== "object" || edit === null) {
      errors[`edits.${index}`] = "Provide a field path and text value.";
      return;
    }
    const entry = edit as Record<string, unknown>;
    const path =
      typeof entry.path === "string" ? entry.path : `edits.${index}.path`;
    if (typeof entry.path !== "string") {
      errors[path] = "Provide a stable Site Definition field path.";
    } else if (typeof entry.value !== "string") {
      errors[path] = "Enter a text value.";
    } else {
      edits.push({ path: entry.path, value: entry.value });
    }
  });
  if (Object.keys(errors).length > 0) {
    return { ok: false, fields: errors };
  }
  try {
    return {
      ok: true,
      body: {
        workspaceId: createContentWorkspaceId(candidate.workspaceId),
        schemaVersion: candidate.schemaVersion as "1.0.0",
        baseRevision: candidate.baseRevision as number,
        edits,
      },
    };
  } catch {
    return {
      ok: false,
      fields: { workspaceId: "Provide a valid workspace ID." },
    };
  }
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
    const parsed = parseSaveBody(await request.json());
    if (!parsed.ok && parsed.fields !== undefined) {
      return Response.json(
        { error: "validation_failed", fields: parsed.fields },
        { status: 422 },
      );
    }
    if (!parsed.ok) {
      return Response.json({ error: "invalid_command" }, { status: 400 });
    }
    const body = parsed.body;
    const application = await loadContentRevisionApplication(
      body.workspaceId,
      access.membership.id,
    );
    const saved = await application.commands.save({
      actorId: access.membership.id,
      workspaceId: body.workspaceId,
      schemaVersion: body.schemaVersion,
      baseRevision: body.baseRevision,
      edits: body.edits,
      idempotencyKey: request.headers.get("idempotency-key") ?? "",
    });
    const capability = await createRevisionPreviewCapability({
      identity: access.identity,
      workspaceId: saved.workspaceId,
      revision: saved.revision,
    });
    const previewQuery = new URLSearchParams({
      capability,
      bookmark: saved.bookmark,
    });
    return Response.json(
      {
        ...saved,
        previewUrl:
          `/preview/${saved.workspaceId}/${saved.revision}` +
          `?${previewQuery.toString()}`,
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
    if (error instanceof ContentRevisionStaleError) {
      return Response.json({ error: "revision_stale" }, { status: 409 });
    }
    if (error instanceof ContentWorkspaceAccessError) {
      return Response.json({ error: "workspace_access_denied" }, { status: 403 });
    }
    if (
      error instanceof AccessIdentityError ||
      error instanceof AccessDeniedError ||
      error instanceof HumanRequestIntegrityError
    ) {
      return Response.json({ error: "request_check_failed" }, { status: 403 });
    }
    if (
      error instanceof HumanAccessConfigurationError ||
      error instanceof ContentRevisionConfigurationError
    ) {
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
