import "server-only";

import { createPublicFormPrivacyApplication } from "@humber-foundry/application";

import { installedSiteDefinition } from "../foundry/site-definition";

import { loadHumanAccessEnvironment } from "./human-access-environment";
import type { HumanAccessRequestContext } from "./human-access-runtime";
import {
  createConfiguredPublicFormPrivacy,
  type PublicFormPrivacyEnvironment,
} from "./public-form-privacy-runtime";

export async function createPublicFormPrivacyContext(
  humanContext: HumanAccessRequestContext,
) {
  if (humanContext.state !== "authorized") {
    throw new Error("form_privacy_not_authorized");
  }
  const environment =
    (await loadHumanAccessEnvironment()) as PublicFormPrivacyEnvironment;
  const { store, vault } = createConfiguredPublicFormPrivacy(environment);
  return createPublicFormPrivacyApplication({
    siteId: installedSiteDefinition.site.id,
    store,
    vault,
    authorize: (actor, capability) =>
      humanContext.application.queries.requireCapability({
        actor,
        capability,
      }),
  });
}
