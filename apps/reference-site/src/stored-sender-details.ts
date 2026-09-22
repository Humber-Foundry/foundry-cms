import {
  createD1SiteSenderDetailsStore,
  emptySiteSenderDetailsStore,
  type SiteSenderDetailsStore,
} from "./d1-site-sender-details-store";
import type { HumanAccessEnvironment } from "./human-access-configuration";
import {
  environmentWithSenderDetails,
  type SiteSenderDetails,
} from "./site-sender-details";

/**
 * Reading the sender details this installation has stored, for every path that
 * builds a campaign footer: the dashboard, the MCP campaign tools, the
 * scheduled send worker and the newsletter signup check.
 *
 * All of them read the settings through this one module, so a stored value can
 * never change the footer on one path and not another. See ADR-0048.
 *
 * This module takes the site id as an argument and never imports the installed
 * site, so the scheduled worker can use it outside a request.
 */

export function siteSenderDetailsStore(
  environment: HumanAccessEnvironment,
): SiteSenderDetailsStore {
  return environment.FOUNDRY_DB === undefined
    ? emptySiteSenderDetailsStore
    : createD1SiteSenderDetailsStore(environment.FOUNDRY_DB);
}

/**
 * The stored sender details for this site, or `null` when nothing was saved.
 *
 * A read that fails returns `null`, so the installation falls back to its
 * environment variables — the behaviour every installation had before anything
 * could be stored. A save reports its own failure, so a lost write is never
 * silent.
 */
export async function readStoredSenderDetails(
  environment: HumanAccessEnvironment,
  siteId: string,
): Promise<SiteSenderDetails | null> {
  try {
    return await siteSenderDetailsStore(environment).read(siteId);
  } catch {
    return null;
  }
}

/**
 * This installation's environment with its stored sender details applied.
 *
 * Every reader downstream keeps reading the environment as it always did, so
 * one rule decides what is missing and what is well formed.
 */
export async function environmentWithStoredSenderDetails<
  Environment extends HumanAccessEnvironment,
>(
  environment: Environment,
  siteId: string,
): Promise<Environment> {
  return environmentWithSenderDetails(
    environment,
    await readStoredSenderDetails(environment, siteId),
  );
}
