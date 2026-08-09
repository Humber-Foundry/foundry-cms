import "server-only";

import type {
  ContentWorkspaceId,
  ExternalHumanIdentity,
} from "@humber-foundry/application";

import {
  readHumanMutationConfiguration,
} from "./human-access-configuration";
import { loadHumanAccessEnvironment } from "./human-access-environment";
import {
  createPreviewCapability,
  verifyPreviewCapability,
} from "./preview-capability";

async function configuration() {
  return readHumanMutationConfiguration(
    await loadHumanAccessEnvironment(),
  );
}

export async function createRevisionPreviewCapability({
  identity,
  workspaceId,
  revision,
}: {
  identity: ExternalHumanIdentity;
  workspaceId: ContentWorkspaceId;
  revision: number;
}) {
  const { audience, secret } = await configuration();
  return createPreviewCapability({
    subject: { identity, workspaceId, revision, audience },
    secret,
  });
}

export async function verifyRevisionPreviewCapability({
  capability,
  identity,
  workspaceId,
  revision,
}: {
  capability: string;
  identity: ExternalHumanIdentity;
  workspaceId: ContentWorkspaceId;
  revision: number;
}) {
  const { audience, secret } = await configuration();
  return verifyPreviewCapability({
    capability,
    subject: { identity, workspaceId, revision, audience },
    secret,
  });
}
