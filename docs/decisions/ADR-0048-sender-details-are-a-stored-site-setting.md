# ADR-0048: The sender details are a stored site setting, with the environment variables as the fallback

- **Status:** Accepted
- **Date:** 2026-09-22
- **Amends:** [ADR-0030](ADR-0030-campaign-channel-configuration-is-a-value.md)

## Context

Every email this product sends must carry four things at the bottom: the
sender's name, the sender's postal address, a way to contact the sender, and a
way to stop the emails. It must also know which sending address the email comes
from. ADR-0030 settled that Foundry never invents any of them: while one is
missing, a campaign cannot be written, tested, scheduled or sent.

Those five values were environment variables only:

- `FOUNDRY_CAMPAIGN_LEGAL_NAME`
- `FOUNDRY_CAMPAIGN_POSTAL_ADDRESS`
- `FOUNDRY_CAMPAIGN_CONTACT_URL`
- `FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL`
- `FOUNDRY_CAMPAIGN_SENDER_IDENTITY_ID`

Settings showed whether they were set and nothing else. An owner who read
"Foundry does not yet have the name and postal address" had no way to supply
one. He had to ask whoever installed the site to redeploy the Worker. These are
his own words and his own addresses, so that is the wrong place for them.

Changing the store alone is not enough. Five separate paths build the same
footer — the dashboard, the campaigns API, the MCP campaign tools, the
scheduled send worker, and the newsletter signup confirmation. If one reads a
stored value and another reads the environment variable, two emails from the
same site carry two different footers.

## Decision

**The five sender details are a stored site setting an Owner edits in Settings.
The environment variable of the same name is the fallback for any value that
was never stored.**

### 1. One row per site

Migration `0039_site_sender_details.sql` adds `site_sender_details`, one row per
site, holding the five values plus who saved them and when. An empty string
means nothing was stored for that one value.

### 2. The rule is per value, not all-or-nothing

`effectiveSenderDetails` in `site-sender-details.ts` takes the stored row and
the environment, and for each of the five values returns the stored one when it
is not empty and the environment one otherwise.

An installation that stored nothing behaves exactly as it did before. An
installation that stored one value keeps reading its environment for the other
four. Nothing an installer set has to be moved for this change to be safe.

### 3. Every path reads it the same way

`environmentWithStoredSenderDetails` in `stored-sender-details.ts` returns the
installation's environment with the stored values written over the five names.
Every caller of `resolveCampaignChannel` passes the result of that function.

The point of returning an environment, rather than a new value type, is that
`resolveCampaignChannel` and `listMissingCampaignSenderSettings` are unchanged.
One rule still decides what is missing and what is well formed, so a value
stored in the dashboard cannot be accepted there and refused by a send.

A read that fails returns "nothing stored", so a database fault leaves an
installation reading its environment variables — the behaviour it had before
anything could be stored.

A save never fails silently. An installation with no database raises
`SiteSenderDetailsUnavailableError`, the route answers 503, and the form says
nothing was saved. The screen shows the true server state, so it must never
report "Saved" for a write that was dropped. The Email tab also reads whether
a store exists (`FOUNDRY_DB`) to decide whether to offer the save at all,
rather than reading `NODE_ENV`: the thing that decides whether a save can be
kept is the store, not the build mode.

### 4. What the save checks

`senderDetailProblems` is given the values the installation would actually use
— the result of `effectiveSenderDetails`, not the raw typed values — and
refuses a save, whole, when any of these is true:

- the name is empty,
- the postal address is empty,
- the contact or unsubscribe address is empty, or
- either address is not an absolute `https://` address with no user name or
  password in it.

Judging the effective values is what makes "leave a field empty to keep what
the installation already uses" true. Judging the typed values alone would
refuse a save that changes one address while the name still comes from the
installation's own setting.

The refusal names the value that is wrong, in the owner's own words. A
half-valid set is never written, because a footer built from one is sent to
every reader.

Settings' Email tab writes its state line from the same problems
(`senderDetailsStateSentence`), so what the screen says is missing and what a
save refuses on can never disagree.

The sending address (`senderIdentityId`) may be left empty in the form. Empty
means "keep what the installation already uses", which is the same rule as
every other value. It is not required here, because whoever installed the site
sets it and delivery readiness already reports it.

### 5. Who may save

Only an Owner. `POST /api/foundry-cms/sender-details` checks `access.manage`,
the owner-only capability the rest of Settings already uses. This ADR does not
add a capability and does not change the access model.

The save replaces all five values at once, so sending the same save twice
leaves the same row. That is why this route carries no idempotency record: a
repeat has no second effect to guard against.

### 6. What is still an environment variable

`FOUNDRY_CAMPAIGN_COMPLIANCE_VERSION` stays an environment variable. It is a
version mark on the footer format, not something an owner writes, and it is
stamped on stored campaign revisions.

Every delivery secret stays an environment variable. Nothing in this table is a
secret; all five values are sent to every reader of every email.

## Consequences

- An owner can set the sender details himself, and a campaign he could not
  write before becomes writable without a redeploy.
- A stored value reaches the dashboard, the campaigns API, an agent's campaign
  tools, the scheduled send worker and the newsletter confirmation message,
  because all five read through one function.
- Every campaign path now makes one extra database read per request to find
  whether anything is stored.
- The setup document's five environment variables become optional for a new
  installation, and stay correct for an old one.
