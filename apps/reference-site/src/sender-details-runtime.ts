import "server-only";

import { loadHumanAccessEnvironment } from "./human-access-environment";
import {
  readStoredSenderDetails,
  siteSenderDetailsStore,
} from "./stored-sender-details";
import {
  effectiveSenderDetails,
  senderDetailProblems,
  senderDetailsAfterEdit,
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
  /**
   * Whether this installation can keep a save at all. An installation with no
   * database — which is what local development runs as — has nowhere to put
   * them, so the form reads as a record rather than offering a save it could
   * not keep.
   */
  editable: boolean;
  /** What is still missing or malformed, in the Owner's own words. */
  problems: ReadonlyArray<SenderDetailProblem>;
}>;

export async function loadSenderDetailsForEditing(): Promise<SenderDetailsForEditing> {
  const environment = await loadHumanAccessEnvironment();
  const stored = await readStoredSenderDetails(
    environment,
    installedSite.application.siteId,
  );
  const values = effectiveSenderDetails(environment, stored);
  return Object.freeze({
    values,
    stored: stored !== null,
    editable: environment.FOUNDRY_DB !== undefined,
    problems: senderDetailProblems(values),
  });
}

/** Why a save was refused, in the Owner's own words, or an empty list. */
export type SenderDetailsSaveRefusal = ReadonlyArray<SenderDetailProblem>;

/**
 * Save all five sender details for this site.
 *
 * The values are checked as the installation would use them — a field left
 * empty keeps whatever the environment variable of the same name holds — and
 * the save is refused whole, so a half-valid set can never reach a campaign
 * footer.
 *
 * The write replaces all five values at once, so sending the same save twice
 * leaves the same row. An installation with no database raises
 * `SiteSenderDetailsUnavailableError` rather than dropping the write.
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
  const environment = await loadHumanAccessEnvironment();
  const siteId = installedSite.application.siteId;
  // A field left empty keeps what the Owner already has: the value saved
  // before where there is one, and the environment variable of the same name
  // where there is not. Writing the typed values straight through would erase
  // a value saved earlier whenever he edits only one field.
  const stored = await readStoredSenderDetails(environment, siteId);
  const toStore = senderDetailsAfterEdit(details, stored);
  const problems = senderDetailProblems(
    effectiveSenderDetails(environment, toStore),
  );
  if (problems.length > 0) return problems;
  await siteSenderDetailsStore(environment).save({
    siteId,
    details: toStore,
    savedBy,
    savedAt,
  });
  return Object.freeze([]);
}
