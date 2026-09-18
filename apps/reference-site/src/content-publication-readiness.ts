import type { HumanAccessEnvironment } from "./human-access-configuration";

/**
 * The document that tells an installer how to connect site publishing. The
 * readiness result carries this path so every screen points at one guide.
 */
export const contentPublicationSetupGuide =
  "docs/operations/github-publishing-readiness.md";

/**
 * How one installation's site publishing is connected.
 *
 * `missingSettings` holds configuration names only, in the same spirit as
 * `CampaignDeliveryReadiness` in `campaign-delivery-readiness.ts`. This
 * result is meant to be shown on screen, so it must never carry a setting's
 * value, a token or a key.
 *
 * - `local_development` — publishing is off because the site runs in local
 *   development. Nothing is published and nothing needs to be installed.
 * - `not_configured` — at least one named setting is absent or invalid.
 * - `connected` — every named setting is installed, so
 *   `readGitHubContentPublisherConfiguration` can build a configuration. This
 *   does not mean GitHub or Cloudflare were reached; it means the settings a
 *   publish needs are present. No connection test runs here.
 */
export type ContentPublicationReadiness = Readonly<{
  state: "connected" | "not_configured" | "local_development";
  missingSettings: ReadonlyArray<ContentPublicationSettingName>;
  setupGuide: string;
}>;

/**
 * Every setting `readGitHubContentPublisherConfiguration` in
 * `github-content-publisher.ts` requires before Foundry can publish a
 * revision to the production site. The order is the order an installer works
 * through the setup document: the GitHub App identity first, then the
 * repository it writes to, then the public address the site is served from,
 * then the Cloudflare deployment it watches, then the signing secret that
 * protects the publication record.
 *
 * `FOUNDRY_PRODUCTION_BRANCH` and `FOUNDRY_DEPLOYMENT_CHECK_NAME` are absent
 * from this list on purpose. Both fall back to a working default
 * (`main` and `Cloudflare`) when absent, so an installation that never sets
 * them is still connected.
 */
export const contentPublicationSettingNames = Object.freeze([
  "FOUNDRY_GITHUB_APP_ID",
  "FOUNDRY_GITHUB_INSTALLATION_ID",
  "FOUNDRY_GITHUB_PRIVATE_KEY",
  "FOUNDRY_GITHUB_OWNER",
  "FOUNDRY_GITHUB_REPOSITORY",
  "FOUNDRY_PUBLIC_ORIGIN",
  "FOUNDRY_CLOUDFLARE_ACCOUNT_ID",
  "FOUNDRY_CLOUDFLARE_SCRIPT_TAG",
  "FOUNDRY_CLOUDFLARE_SCRIPT_NAME",
  "FOUNDRY_CLOUDFLARE_BUILD_TRIGGER_ID",
  "FOUNDRY_CLOUDFLARE_API_TOKEN",
  "FOUNDRY_PUBLICATION_SIGNING_SECRET",
] as const);

/** One named publishing setting. */
export type ContentPublicationSettingName =
  (typeof contentPublicationSettingNames)[number];

function isPresent(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

/**
 * `readGitHubContentPublisherConfiguration` rejects a public origin that does
 * not parse as an absolute `https:` address. This mirrors that check without
 * throwing, so a malformed origin is reported as missing rather than crashing
 * the readiness report.
 */
function isHttpsOrigin(value: string | undefined): boolean {
  if (!isPresent(value)) return false;
  try {
    return new URL(value!).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * `readGitHubContentPublisherConfiguration` rejects a publication signing
 * secret shorter than 32 bytes. This mirrors that check without throwing.
 */
function isLongEnoughSecret(value: string | undefined): boolean {
  return (
    isPresent(value) && new TextEncoder().encode(value!.trim()).byteLength >= 32
  );
}

/**
 * Whether each named publishing setting is installed and well formed. Each
 * rule matches the reader that consumes the setting later
 * (`readGitHubContentPublisherConfiguration`), so a setting reported as
 * installed here cannot make that reader throw.
 *
 * This never reads a value into the result. It answers only yes or no per
 * name.
 */
const contentPublicationSettingChecks: Readonly<
  Record<
    ContentPublicationSettingName,
    (environment: HumanAccessEnvironment) => boolean
  >
> = Object.freeze({
  FOUNDRY_GITHUB_APP_ID: (environment) =>
    isPresent(environment.FOUNDRY_GITHUB_APP_ID),
  FOUNDRY_GITHUB_INSTALLATION_ID: (environment) =>
    isPresent(environment.FOUNDRY_GITHUB_INSTALLATION_ID),
  FOUNDRY_GITHUB_PRIVATE_KEY: (environment) =>
    isPresent(environment.FOUNDRY_GITHUB_PRIVATE_KEY),
  FOUNDRY_GITHUB_OWNER: (environment) =>
    isPresent(environment.FOUNDRY_GITHUB_OWNER),
  FOUNDRY_GITHUB_REPOSITORY: (environment) =>
    isPresent(environment.FOUNDRY_GITHUB_REPOSITORY),
  FOUNDRY_PUBLIC_ORIGIN: (environment) =>
    isHttpsOrigin(environment.FOUNDRY_PUBLIC_ORIGIN),
  FOUNDRY_CLOUDFLARE_ACCOUNT_ID: (environment) =>
    isPresent(environment.FOUNDRY_CLOUDFLARE_ACCOUNT_ID),
  FOUNDRY_CLOUDFLARE_SCRIPT_TAG: (environment) =>
    isPresent(environment.FOUNDRY_CLOUDFLARE_SCRIPT_TAG),
  FOUNDRY_CLOUDFLARE_SCRIPT_NAME: (environment) =>
    isPresent(environment.FOUNDRY_CLOUDFLARE_SCRIPT_NAME),
  FOUNDRY_CLOUDFLARE_BUILD_TRIGGER_ID: (environment) =>
    isPresent(environment.FOUNDRY_CLOUDFLARE_BUILD_TRIGGER_ID),
  FOUNDRY_CLOUDFLARE_API_TOKEN: (environment) =>
    isPresent(environment.FOUNDRY_CLOUDFLARE_API_TOKEN),
  FOUNDRY_PUBLICATION_SIGNING_SECRET: (environment) =>
    isLongEnoughSecret(environment.FOUNDRY_PUBLICATION_SIGNING_SECRET),
});

/**
 * The names of the publishing settings this installation still needs, in
 * setup order. An empty list means every publishing setting is installed.
 */
export function listMissingContentPublicationSettings(
  environment: HumanAccessEnvironment,
): ReadonlyArray<ContentPublicationSettingName> {
  return Object.freeze(
    contentPublicationSettingNames.filter(
      (name) => !contentPublicationSettingChecks[name](environment),
    ),
  );
}
