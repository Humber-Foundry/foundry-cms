import type { CampaignChannelConfiguration } from "./campaign-types";

/**
 * The one reason every path reports while an installation has not set its
 * sender details and email footer.
 *
 * Creating a campaign, editing it, sending a test, authorizing a send,
 * scheduling a send, sending now, the MCP campaign tools and the scheduled
 * worker all report this same word. An Owner who reads it on the Newsletter
 * page and an operator who reads it in a scheduler log are reading about the
 * same missing settings.
 */
export const campaignSenderDetailsNotConfiguredReason =
  "campaign_sender_details_not_configured";

/**
 * Whether one installation has the sender identity and the compliance footer it
 * must put at the bottom of every email.
 *
 * This is a value, not an exception. Every caller that builds a campaign
 * application has to read `state` before it can reach the configuration, so no
 * caller can forget to handle the missing case.
 *
 * Foundry never invents a legal name, a postal address, a contact address or an
 * unsubscribe address. The footer is stored on every campaign revision and is
 * read by whoever receives the email, so there is no default and no
 * placeholder: while the settings are absent the work is refused instead.
 *
 * `missingSettings` holds configuration names only. It never holds a value.
 */
export type CampaignChannelConfigurationState =
  | Readonly<{
      state: "configured";
      configuration: CampaignChannelConfiguration;
    }>
  | Readonly<{
      state: "not_configured";
      reason: typeof campaignSenderDetailsNotConfiguredReason;
      missingSettings: ReadonlyArray<string>;
    }>;

/** The sender details and footer this installation has set. */
export function configuredCampaignChannel(
  configuration: CampaignChannelConfiguration,
): CampaignChannelConfigurationState {
  return Object.freeze({ state: "configured" as const, configuration });
}

/**
 * The sender details and footer are not set. `missingSettings` names the
 * settings that are still absent, in the order the setup document works
 * through them.
 */
export function campaignChannelNotConfigured(
  missingSettings: ReadonlyArray<string>,
): CampaignChannelConfigurationState {
  return Object.freeze({
    state: "not_configured" as const,
    reason: campaignSenderDetailsNotConfiguredReason,
    missingSettings: Object.freeze([...missingSettings]),
  });
}

/**
 * One application's commands, with every command that is not named in
 * `allowed` replaced by a refusal.
 *
 * `allowed` names what still works rather than what is blocked, so a command
 * added later is refused until someone allows it here deliberately. A list of
 * blocked names would let a new command through by omission.
 *
 * Every command is asynchronous, so the refusal is a rejected promise. A
 * synchronous throw would escape a caller that only attaches a catch to the
 * promise.
 */
export function refuseCommandsExcept<Commands extends object>(
  commands: Commands,
  allowed: ReadonlyArray<keyof Commands>,
  raise: () => Error,
): Commands {
  async function refuse(): Promise<never> {
    throw raise();
  }
  return Object.freeze(
    Object.fromEntries(
      Object.keys(commands).map((name) => [
        name,
        (allowed as ReadonlyArray<string>).includes(name)
          ? commands[name as keyof Commands]
          : refuse,
      ]),
      // Every replaced entry throws, so it satisfies any command signature.
      // The cast is only needed because the keys are walked by name.
    ) as unknown as Commands,
  );
}
