import type { HumanAccessEnvironment } from "./human-access-configuration";

/**
 * Whether a named setting is installed and well formed.
 *
 * Every readiness report in this installation answers the same question about
 * its own list of settings, so the rules live in one place. Each rule matches
 * the reader that consumes the setting later, so a setting reported as
 * installed here cannot make that reader throw.
 *
 * None of these ever read a value into a result. They answer only yes or no.
 */

export function isPresent(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

/**
 * A secret is long enough when it holds at least 32 characters. The readers in
 * `human-access-configuration.ts` measure the untrimmed value, so this measures
 * it the same way.
 */
export function isLongEnoughSecret(value: string | undefined): boolean {
  return isPresent(value) && value!.length >= 32;
}

/** A JSON object with at least one entry, such as the sender mapping. */
export function isNonEmptyJsonObject(value: string | undefined): boolean {
  if (!isPresent(value)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value!);
  } catch {
    return false;
  }
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    Object.keys(parsed).length > 0
  );
}

/** An absolute https address with no credentials in it. */
export function isHttpsUrl(value: string | undefined): boolean {
  if (!isPresent(value)) return false;
  try {
    const parsed = new URL(value!.trim());
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

/**
 * The document that tells an installer how to connect email delivery. Every
 * readiness result carries this path, so every screen points at one guide.
 */
export const emailDeliverySetupGuide =
  "docs/operations/brevo-test-delivery-readiness.md";

/** Narrows a settings check to the environment shape it reads. */
export type SettingCheck<Environment extends HumanAccessEnvironment> = (
  environment: Environment,
) => boolean;
