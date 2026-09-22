# ADR-0021: One shared component reports whether email and publishing are connected

- **Status:** Accepted, amended
- **Date:** 2026-09-18

## Context

Nothing in the dashboard said whether email delivery or site publishing was
connected. In local development both are off, and the screens did not say so,
which made Publish look like it did nothing.

#163 already answers this for email delivery:
`readCampaignDeliveryReadiness` in `campaign-runtime.ts` reports `connected`,
`not_configured` or `local_development`, plus the names of any missing
settings. Nothing equivalent existed for site publishing. Publishing is read
by `readGitHubContentPublisherConfiguration` in `github-content-publisher.ts`,
which throws `GitHubContentPublisherConfigurationError` the moment any one
setting is absent, so it cannot itself list every missing name, and it makes
no network call, so it cannot say whether a real connection was proven.

## Decision

**A read-only publishing readiness check mirrors the delivery one, and both
report through one shared screen component.**

### 1. Publishing readiness

`content-publication-readiness.ts` lists the settings
`readGitHubContentPublisherConfiguration` requires
(`FOUNDRY_GITHUB_APP_ID`, `FOUNDRY_GITHUB_INSTALLATION_ID`,
`FOUNDRY_GITHUB_PRIVATE_KEY`, `FOUNDRY_GITHUB_OWNER`,
`FOUNDRY_GITHUB_REPOSITORY`, `FOUNDRY_PUBLIC_ORIGIN`,
`FOUNDRY_CLOUDFLARE_ACCOUNT_ID`, `FOUNDRY_CLOUDFLARE_SCRIPT_TAG`,
`FOUNDRY_CLOUDFLARE_SCRIPT_NAME`, `FOUNDRY_CLOUDFLARE_BUILD_TRIGGER_ID`,
`FOUNDRY_CLOUDFLARE_API_TOKEN`, `FOUNDRY_PUBLICATION_SIGNING_SECRET`), each
checked with the same rule the reader applies, without reading a value into
the result. `FOUNDRY_PRODUCTION_BRANCH` and `FOUNDRY_DEPLOYMENT_CHECK_NAME`
are left out because both fall back to a working default.

`readContentPublicationReadiness` in `content-publication-runtime.ts` reports
`local_development` when the site runs in local development (matching
`content-publication-runtime.ts`'s own `local_publication_disabled` publisher
path), otherwise `connected` or `not_configured` from the missing-settings
list. It makes no GitHub or Cloudflare call, so `connected` means the
settings are present, not that a publish was proven. The report is served
read-only at `GET /api/foundry-cms/publishing-readiness`, its own route
rather than a query parameter on `publications`, so it never becomes one more
fetch a `publications`-focused test has to account for.

### 2. One shared component

`components/connection-status.tsx` exports `ConnectionStatus`, which turns a
`{ state, missingSettings, setupGuide }` result into one plain-English line
for either `kind="email"` or `kind="publishing"`, and
`PublishingConnectionStatus`, which fetches the publishing report once and
renders it. Both `CampaignDeliveryReadiness` and `ContentPublicationReadiness`
already share this shape, so no adapter is needed between them.

The component never renders `missingSettings` as anything but a joined list
of names, and never renders a value, a token, a key or a personal address.

### 3. Where it shows

- **Newsletter** (`campaign-controls.tsx`, split into `campaign-send-flow.tsx`
  and its sibling screens by #237): the existing "not connected" note
  in the sending steps is replaced with `<ConnectionStatus kind="email" />`.
  Steps 2 to 4 keep disabling while not connected; only the note changed.
- **Blog** (`blog-post-controls.tsx`): `<PublishingConnectionStatus />` sits
  next to the pending-site-publish banner from #166.
- **Pages** (`content-editor.tsx`): `<PublishingConnectionStatus />` sits at
  the top of the publish panel.
- **Settings** (`app/dash/settings/page.tsx`): a new Connections section
  renders both `<ConnectionStatus kind="email" />` and
  `<ConnectionStatus kind="publishing" />`, read server-side so it needs no
  fetch.

## Consequences

- A site owner can now tell, in plain words, whether either connection is
  installed, and read the exact settings still missing, from every screen
  where they do the work.
- #183 added the sender and compliance settings under their own heading. The
  expectation written here — that `ConnectionStatus` would need no change —
  did not hold: the owner does not read setting names, so that heading says
  what is missing in plain words and keeps the names behind a disclosure.
  [ADR-0030](ADR-0030-campaign-channel-configuration-is-a-value.md) amends
  this ADR with a third `ConnectionKind` and a per-kind rule for whether the
  names belong on the line. The `email` and `publishing` kinds are unchanged.
- The publishing readiness check never calls GitHub or Cloudflare. A future
  ticket that wants to prove a working connection, not just present settings,
  needs a new state or a separate signal; this ADR does not add one.
