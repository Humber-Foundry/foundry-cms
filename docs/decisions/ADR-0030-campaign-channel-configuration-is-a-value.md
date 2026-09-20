# ADR-0030: The campaign channel configuration is a value, and there is no default compliance footer

- **Status:** Accepted
- **Date:** 2026-09-19
- **Amends:** [ADR-0021](ADR-0021-connection-status-shared-component.md)

## Context

Every campaign email carries a footer at the bottom with the sender's legal
name, postal address, a way to make contact and a way to stop the emails.
Foundry builds that footer from six installation settings:
`FOUNDRY_CAMPAIGN_SENDER_IDENTITY_ID`, `FOUNDRY_CAMPAIGN_LEGAL_NAME`,
`FOUNDRY_CAMPAIGN_POSTAL_ADDRESS`, `FOUNDRY_CAMPAIGN_CONTACT_URL`,
`FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL` and
`FOUNDRY_CAMPAIGN_COMPLIANCE_VERSION`.

The reader threw `CampaignChannelConfigurationError` the moment one of them
was absent. `loadCampaignRequestContext` calls it while the Newsletter page
renders, and nothing caught it, so a new installation — which holds none of
the six — got a 500 error page instead of Newsletter.
Settings had the same fault, which took away the one screen that could have
explained it.

#163 made the page load without the delivery secrets. It deliberately left
these six alone, because during its review an early version stood in a
placeholder footer, and a campaign saved then could later have been **sent**
with that placeholder in place of the legal name and postal address. A footer
is stored on the campaign revision and read by whoever receives the email, so
a wrong one is not a display fault; it is a false statement sent to every
subscriber.

Two ways to fix the crash were possible and both were rejected:

- **A default footer.** Rejected. Foundry has no truthful value to use.
- **Catch the exception at each caller.** Rejected. There are four composing
  roots (the page, the API route, the MCP runtime, the scheduled worker) and
  nothing makes a fifth one remember. #163's review found exactly this class
  of fault twice: a blocked-action list that failed open, and a bare
  `TypeError: Invalid URL` where a named reason belonged.

## Decision

**The channel configuration is a typed value that every caller must read
before it can reach the configuration, and no campaign revision may be
created, edited, tested, authorized, scheduled or sent while it says the
settings are absent.**

### 1. The contract in `packages/application`

`campaign-channel-state.ts` adds:

```ts
export const campaignSenderDetailsNotConfiguredReason =
  "campaign_sender_details_not_configured";

export type CampaignChannelConfigurationState =
  | Readonly<{ state: "configured"; configuration: CampaignChannelConfiguration }>
  | Readonly<{
      state: "not_configured";
      reason: typeof campaignSenderDetailsNotConfiguredReason;
      missingSettings: ReadonlyArray<string>;
    }>;
```

`createCampaignApplication`, `createCampaignTestDeliveryApplication` and
`createCampaignBulkDeliveryApplication` all take this value instead of a bare
`CampaignChannelConfiguration`. TypeScript will not let a caller read
`configuration` without narrowing `state` first, so the missing case cannot be
forgotten. It is not an exception, so it cannot be dropped by a missing
`catch` either.

`missingSettings` holds configuration names only, never a value.

### 2. One reason, everywhere

Every refusal reports `campaign_sender_details_not_configured`:

- **Create and edit** throw a `CampaignValidationError` with that message,
  which the existing command seam records as a rejected command with that
  reason. Nothing is stored.
- **Test delivery** refuses every command before the provider is asked for
  anything.
- **Bulk delivery** refuses every command and every scheduler entry point.
- The **MCP campaign runtime** and the **scheduled worker** read the same
  value and stop with the same word.
- The **campaigns API** answers HTTP 503 with that reason.

### 3. Refusal lists name what is allowed

Three places keep a list: the API route's `actionsAllowedWithoutSenderDetails`,
the application's `bulkCommandsAllowedWithoutSenderDetails`, and its
`testCommandsAllowedWithoutSenderDetails`. Each names what still works rather
than what is blocked, so a command added later is refused until someone allows
it deliberately. This follows #163's decision after its review found a blocked
list that failed open. The test list is empty, and is written out anyway so the
next command added there meets the same gate.

Only two commands survive, and neither sends anything: `cancel_bulk_schedule`
(cancelling stops a send, and an Owner needs it exactly when something has gone
wrong) and recording a verified provider event (dropping one would lose an
unsubscribe). Reads are untouched throughout.

### 4. One reading of the settings serves both the screen and the refusal

`resolveCampaignChannel` in `campaign-channel-configuration.ts` returns the
channel value and the readiness report together, from one reading. All four
composing roots call it. The screen can therefore never name a different set
of missing settings from the one the application refused on, and the rule
lives in one place rather than in four copies.

### 5. Reading still works

Listing and reading the campaigns that are already stored is untouched. That
is what lets the Newsletter page load and say what is missing. A footer that
was stored while the settings were set stays exactly as the installation wrote
it; nothing rewrites or re-derives a stored footer.

### 6. Two headings, not one

Readiness reports the sender settings under `senderDetails`, beside
`delivery`, in the same shape. They are separate settings with separate
consequences: without the delivery secrets a campaign can still be written but
not sent; without the sender details it cannot even be written. Keeping them
apart also keeps each list short enough to act on. The two lists never
overlap.

### 7. Plain words on screen, setting names for the operator

The shared `ConnectionStatus` component (ADR-0021) gains a `senderDetails`
kind. For that kind the line says what is missing in the owner's own words —
"the name and postal address that must appear at the bottom of every email" —
and the setting names sit inside a `HelpTip` disclosure beside the link to the
setup document. The `email` and `publishing` kinds keep ADR-0021's behaviour
of naming the settings on the line, because an operator installs those.

### 8. Local development is the one named exception

In local development the campaign store is in memory, every provider adapter
is the fail-closed one, and delivery readiness reports `local_development`, so
nothing written there can reach a person. That mode keeps a footer that
announces itself — the name reads "Foundry local development" and the address
reads "Local development only" — so it cannot be mistaken for a real legal
name or a real postal address. It is named here so the rule above is read
exactly: **outside local development** there is no default and no placeholder.

## Consequences

- A new installation opens Newsletter, reads what is missing, and follows one
  link. It no longer sees an error page.
- Outside local development, no campaign revision can hold a placeholder,
  empty or invented compliance footer. This is proved at the application
  layer, not only on screen.
- Adding a campaign command means deciding whether it belongs on the allowed
  list. Until then it is refused, which is the safe direction.
- The scheduled worker stops rather than claiming work it would refuse one
  operation at a time. An operator sees one clear reason in the log.
- Anything that builds a campaign application must now pass the state value.
  That is a compile error rather than a silent crash at request time.
