import "server-only";

import { loadHumanAccessEnvironment } from "./human-access-environment";
import {
  readStoredSenderDetails,
  siteSenderDetailsStore,
} from "./stored-sender-details";
import {
  effectiveSenderDetails,
  senderDetailProblems,
  type SenderDetailProblem,
  type SiteSenderDetails,
} from "./site-sender-details";
import { installedSite } from "../foundry/site-definition.server";

/**
 * What Settings' Email tab reads and writes.
 *
 * The rule itself lives in `stored-sender-details.ts`, which every campaign
 * path shares. This module only adds the installed site and the request-time
 * environment. See ADR-0048.
 */

/** What Settings' Email tab shows in the sender details form. */
export type SenderDetailsForEditing = Readonly<{
  /**
   * The values in use now: the stored value where there is one, otherwise what
   * the environment variable of the same name says.
   */
  values: SiteSenderDetails;
  /** Whether anything is stored, so the screen can say where the values came from. */
  stored: boolean;
  /** Whether this installation runs in local development, where nothing is sent. */
  localDevelopment: boolean;
}>;

export async function loadSenderDetailsForEditing(): Promise<SenderDetailsForEditing> {
  const environment = await loadHumanAccessEnvironment();
  const stored = await readStoredSenderDetails(
    environment,
    installedSite.application.siteId,
  );
  return Object.freeze({
    values: effectiveSenderDetails(environment, stored),
    stored: stored !== null,
    localDevelopment: process.env.NODE_ENV === "development",
  });
}

/** Why a save was refused, in the Owner's own words, or an empty list. */
export type SenderDetailsSaveRefusal = ReadonlyArray<SenderDetailProblem>;

/**
 * Save all five sender details for this site.
 *
 * The values are checked first and the save is refused whole, so a half-valid
 * set can never reach a campaign footer. The write replaces all five values at
 * once, so sending the same save twice leaves the same row.
 */
export async function saveSenderDetails({
  details,
  savedBy,
  savedAt,
}: {
  details: SiteSenderDetails;
  savedBy: string;
  savedAt: string;
}): Promise<SenderDetailsSaveRefusal> {
  const problems = senderDetailProblems(details);
  if (problems.length > 0) return problems;
  const environment = await loadHumanAccessEnvironment();
  await siteSenderDetailsStore(environment).save({
    siteId: installedSite.application.siteId,
    details,
    savedBy,
    savedAt,
  });
  return Object.freeze([]);
}
