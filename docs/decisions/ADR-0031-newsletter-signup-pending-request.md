# ADR-0031: A newsletter signup is a pending request, not a subscriber

- **Status:** Accepted
- **Date:** 2026-09-19

## Context

Before #167 there was no public newsletter signup. The subscriber ledger
(`packages/application/src/subscriber-ledger.ts`) held subscribers, their state
and their consent evidence, and every path into it was authenticated: an Owner
recording consent by hand, or a provider callback reporting a suppression. The
only public newsletter surface was the unsubscribe page.

Signup has to be open to the public, and that changes the risk. Anybody can
type anybody else's address into a public form. Canadian and European consent
law both treat "somebody typed this address" as no evidence of consent at all.
So a public form needs a second step: the person who owns the address has to
show that they meant it.

We had to decide where a person who has typed an address but not yet confirmed
lives.

Two options were considered.

**A pending subscriber state.** Add `pending` to `SubscriberState` and let the
subscriber row exist from the moment the form is filled in.

**A separate pending request.** Keep the subscriber ledger as the record of
confirmed subscribers only, and hold unconfirmed signups in their own table.

## Decision

A signup is a **pending request** in `newsletter_signup_requests`. It is not a
subscriber. A subscriber row is written only when the person opens the signed
confirmation link.

The reasons:

- **`SubscriberState` already means something.** Its values are ordered by how
  restrictive they are, and `moreRestrictiveState` uses that order to decide
  what a suppression overwrites. A `pending` value has no honest place in that
  order: it is not a degree of suppression, it is the absence of a subscriber.
- **Bulk sending is proved by construction.** `createCampaignBulkAudience`
  reads the subscriber ledger. A pending request is not in that ledger, so it
  cannot become a recipient by mistake. No new filter has to be remembered in a
  future change, and no future reader of the ledger can get it wrong.
- **An unconfirmed address can be forgotten cheaply.** The pending table holds
  the address only while a confirmation could still arrive. Confirming,
  superseding or expiring a request clears the address in the same SQL
  statement, and a CHECK constraint refuses any settled row that still holds
  one. A subscriber row could not be emptied so freely, because the ledger is
  an append-only record of consent.
- **The counts an agent sees stay honest.** `eligibleSubscriberCount` counts
  active subscribers. With pending requests outside the ledger, that number
  never includes somebody who has not agreed.

Four further rules follow from the same reasoning.

**The link, not the message, is the consent.** `GET /newsletter/confirm` shows
a button and does nothing. `POST` does the work. A mail scanner that opens
every link in a message cannot subscribe anybody.

**The confirmation token is the unsubscribe token's twin.** It is signed with
the same `FOUNDRY_NEWSLETTER_DELIVERY_SECRET`, under its own context string
(`foundry.newsletter-confirm.v1`), so a token minted for one purpose is refused
for the other. It carries the request id and the address's identity key, never
the address.

**The public answer never depends on the address.** A new address, an address
already subscribed, and an address that can never be added again all get the
same `202` and the same body. Without this rule the form is an address
checker.

**No confirmation message means no address taken.** The confirmation message is
transactional, and it carries the same legal footer a campaign carries, because
the law that asks for a footer on a campaign asks for the same footer here.
When the sender identity or a compliance setting is missing,
`readNewsletterSignupReadiness` reports `not_configured`, the form says signup
is not available, and the route refuses before it reads the address from the
body. This is the same typed readiness shape #163 and #183 use, and it names
settings only — never a value.

## Consequences

- A new migration, `0029_newsletter_signup.sql`, adds
  `newsletter_signup_requests` and `newsletter_confirmation_jobs`. A partial
  unique index allows one pending request per address, so two live confirmation
  links can never both create a subscriber.
- The confirmation message is sent by a durable job with a lease and a bounded
  retry, drained by the existing cron, the same shape the public form
  notification job uses. A lease that runs out is treated as a failure rather
  than retried, so nobody is sent a second message they did not ask for.
- `NewsletterConfirmationSender` is a narrow port. The Brevo transactional
  adapter behind it is replaceable, as ADR-0002 requires, and Foundry stays
  authoritative for consent and suppression.
- An erased address is never re-added. Erasure is a standing instruction not to
  hold the address, and a form submission is not evidence that the erased
  person asked to come back. An unsubscribed or bounced address can come back,
  but only through a fresh confirmation by whoever holds it.
- Signup needs JavaScript, because Turnstile is checked on the server and fails
  closed. The confirmation page needs none. The form says so in a `<noscript>`
  block instead of failing silently.
- Owners still see the subscriber list through the existing Owner-only
  `listIdentities` and `exportLedger` queries, each of which writes a sensitive
  access audit record. A dashboard screen for that list is not in this change.
