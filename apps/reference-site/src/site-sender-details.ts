import { isHttpsUrl, isPresent } from "./settings-presence";
import type { HumanAccessEnvironment } from "./human-access-configuration";
import type { CampaignSenderSettingName } from "./campaign-delivery-readiness";

/**
 * The sender details an Owner edits in Settings: who the email is from, and
 * the name, postal address, contact address and unsubscribe address that must
 * appear at the bottom of every email.
 *
 * These used to be environment variables only, which meant nobody could set
 * them from inside the product. They are now a stored site setting, and the
 * environment variables stay as the fallback so an installation that already
 * set them keeps working. See ADR-0048.
 *
 * Every value here is the Owner's own words or the Owner's own addresses. None
 * of them is a secret, so this module may return values to an owner-only
 * screen. It never reads any other setting.
 */

/** The five values, in the order the Owner reads them on the Email tab. */
export const senderDetailFieldNames = Object.freeze([
  "legalName",
  "postalAddress",
  "contactUrl",
  "unsubscribeUrl",
  "senderIdentityId",
] as const);

/** One sender detail value. */
export type SenderDetailFieldName = (typeof senderDetailFieldNames)[number];

/** All five values together. An unset value is the empty string. */
export type SiteSenderDetails = Readonly<
  Record<SenderDetailFieldName, string>
>;

/**
 * The environment variable each stored value replaces. One map, so the store,
 * the screen and the campaign channel reader can never disagree about which
 * setting a value stands for.
 */
export const senderDetailEnvironmentName: Readonly<
  Record<SenderDetailFieldName, CampaignSenderSettingName>
> = Object.freeze({
  legalName: "FOUNDRY_CAMPAIGN_LEGAL_NAME",
  postalAddress: "FOUNDRY_CAMPAIGN_POSTAL_ADDRESS",
  contactUrl: "FOUNDRY_CAMPAIGN_CONTACT_URL",
  unsubscribeUrl: "FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL",
  senderIdentityId: "FOUNDRY_CAMPAIGN_SENDER_IDENTITY_ID",
});

/**
 * What the Owner reads as the name of each value. The dashboard shows these,
 * never the environment variable names.
 */
export const senderDetailLabel: Readonly<
  Record<SenderDetailFieldName, string>
> = Object.freeze({
  legalName: "Your name as it appears on the email",
  postalAddress: "Your postal address",
  contactUrl: "Web address where people can contact you",
  unsubscribeUrl: "Web address where people can stop the emails",
  senderIdentityId: "Which sender the email comes from",
});

/** One short sentence under each field, saying what it is for. */
export const senderDetailHint: Readonly<
  Record<SenderDetailFieldName, string>
> = Object.freeze({
  legalName:
    "The name a reader will recognise. The law requires a real name, so " +
    "Foundry never writes one for you.",
  postalAddress:
    "A real postal address. Every email must carry one.",
  contactUrl:
    "Must start with https:// and be the full address of a page on your site.",
  unsubscribeUrl:
    "Must start with https:// and be a page on your site. Foundry adds each " +
    "reader's own code to this address.",
  senderIdentityId:
    "The name whoever set up email delivery gave the sending address. Leave " +
    "it as it is unless they tell you to change it.",
});

/**
 * All five values, each read by the same rule. Adding a sixth detail is then
 * one entry in `senderDetailFieldNames` and one entry in each map above,
 * rather than an edit to every reader in this file.
 */
function senderDetailsBy(
  read: (field: SenderDetailFieldName) => string,
): SiteSenderDetails {
  return Object.freeze(
    Object.fromEntries(
      senderDetailFieldNames.map((field) => [field, read(field)]),
    ),
  ) as SiteSenderDetails;
}

/**
 * The values this installation would use if nothing were stored: what the
 * environment variables say, trimmed.
 */
export function senderDetailsFromEnvironment(
  environment: HumanAccessEnvironment,
): SiteSenderDetails {
  return senderDetailsBy((field) =>
    (environment[senderDetailEnvironmentName[field]] ?? "").trim(),
  );
}

/**
 * The values this installation actually uses: a stored value wins, and a value
 * that was never stored falls back to the environment variable.
 *
 * The rule is per value, not all-or-nothing, so an installation can store one
 * value today and keep reading the other four from its environment.
 */
export function effectiveSenderDetails(
  environment: HumanAccessEnvironment,
  stored: SiteSenderDetails | null,
): SiteSenderDetails {
  const fromEnvironment = senderDetailsFromEnvironment(environment);
  if (stored === null) return fromEnvironment;
  return senderDetailsBy((field) => {
    const value = stored[field].trim();
    return value === "" ? fromEnvironment[field] : value;
  });
}

/**
 * The environment this installation reads once the stored values are applied.
 *
 * Returning an environment-shaped value rather than a new value type keeps one
 * rule for what is missing and what is well formed: `resolveCampaignChannel`
 * and `listMissingCampaignSenderSettings` are unchanged and still decide.
 */
export function environmentWithSenderDetails<
  Environment extends HumanAccessEnvironment,
>(
  environment: Environment,
  stored: SiteSenderDetails | null,
): Environment {
  if (stored === null) return environment;
  const effective = effectiveSenderDetails(environment, stored);
  const applied: Record<string, unknown> = { ...environment };
  for (const field of senderDetailFieldNames) {
    applied[senderDetailEnvironmentName[field]] = effective[field];
  }
  return applied as Environment;
}

/** One value the Owner must fix before the save is accepted. */
export type SenderDetailProblem = Readonly<{
  field: SenderDetailFieldName;
  message: string;
}>;

/**
 * What is wrong with a set of sender details, in plain words.
 *
 * Call this with the values the installation would actually use — the result
 * of `effectiveSenderDetails` — never with the raw typed values. Leaving a
 * field empty means "keep what the installation already uses", so judging the
 * typed values alone would refuse a save that changes one address while the
 * name still comes from the installation's own setting.
 *
 * A name and a postal address are required: no campaign may be written or sent
 * without them, and Foundry must never stand one in. A web address that is
 * present must be a full `https://` address, because it is sent to every
 * reader.
 *
 * This is also what the Email tab reads to write its state line, so what the
 * screen says is missing and what a save refuses on can never disagree.
 */
export function senderDetailProblems(
  details: SiteSenderDetails,
): ReadonlyArray<SenderDetailProblem> {
  const problems: SenderDetailProblem[] = [];
  if (!isPresent(details.legalName)) {
    problems.push({
      field: "legalName",
      message: "Add the name that appears at the bottom of every email.",
    });
  }
  if (!isPresent(details.postalAddress)) {
    problems.push({
      field: "postalAddress",
      message:
        "Add the postal address that appears at the bottom of every email.",
    });
  }
  const addressMissing: Readonly<
    Record<"contactUrl" | "unsubscribeUrl", string>
  > = {
    contactUrl: "Add the web address where people can contact you.",
    unsubscribeUrl:
      "Add the web address where people can stop the emails.",
  };
  for (const field of ["contactUrl", "unsubscribeUrl"] as const) {
    const value = details[field].trim();
    if (value === "") {
      problems.push({ field, message: addressMissing[field] });
    } else if (!isHttpsUrl(value)) {
      problems.push({
        field,
        message:
          "Write the full web address, starting with https:// and with no " +
          "user name or password in it.",
      });
    }
  }
  return Object.freeze(problems);
}

/**
 * The values to store when the Owner saves, given what he typed and what is
 * stored now.
 *
 * A field left empty means "keep what I already have". Keeping means the
 * stored value where there is one, so a save that changes one address cannot
 * erase a value saved earlier. A field that was never stored stays empty here,
 * which is what leaves the environment variable of the same name in use.
 */
export function senderDetailsAfterEdit(
  typed: SiteSenderDetails,
  stored: SiteSenderDetails | null,
): SiteSenderDetails {
  return senderDetailsBy((field) => {
    const value = typed[field].trim();
    return value === "" ? (stored?.[field].trim() ?? "") : value;
  });
}

/**
 * One plain sentence about the sender details, for the Email tab.
 *
 * It names what is missing rather than reporting a state, because "not
 * configured" tells an owner nothing he can act on. The named problems are the
 * same ones a save refuses on, so the screen and the save always agree.
 *
 * `sendGateOpen` is what the campaign send itself answers. It covers two
 * settings the Owner does not edit here — which sender the email comes from,
 * and the footer's version mark — so this never says the details are set while
 * a send would still be refused.
 */
export function senderDetailsStateSentence(
  problems: ReadonlyArray<SenderDetailProblem>,
  sendGateOpen: boolean,
): string {
  if (problems.length > 0) {
    return `Email cannot be sent yet. ${problems
      .map((problem) => problem.message)
      .join(" ")}`;
  }
  if (!sendGateOpen) {
    return (
      "Email cannot be sent yet. Everything you can set here is set, so ask " +
      "whoever set this site up to finish the email settings."
    );
  }
  return "Your sender details are set. Every email carries them at the bottom.";
}

/**
 * The five values out of whatever a request sent, as strings.
 *
 * A request that omits a value, or sends something that is not a string, gets
 * the empty string for it. An empty stored value means "keep reading the
 * environment variable", so this can never stand a value in.
 */
export function readSenderDetails(value: unknown): SiteSenderDetails | null {
  if (typeof value !== "object" || value === null) return null;
  const source = value as Record<string, unknown>;
  return senderDetailsBy((field) => {
    const raw = source[field];
    return typeof raw === "string" ? raw.trim() : "";
  });
}
