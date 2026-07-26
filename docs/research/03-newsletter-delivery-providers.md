# Newsletter delivery providers and portable subscriber export

Issue: [#3](https://github.com/Galen-Humber-Foundry/foundry-cms/issues/3)  
Research date: 2026-07-25  
Scope: provider evidence and a replaceable adapter boundary; no provider selection

## Executive summary

Five providers can plausibly act as a delivery adapter while Foundry CMS remains the authoring, approval, scheduling-intent, and reporting surface:

- **Brevo** has the most complete documented API path in this shortlist for inline-HTML campaigns, scheduled sends, test delivery, contact export, aggregate reports, and marketing webhooks. Its current OAuth implementation is private to one Brevo organization, so isolated client installations would initially need client-created API keys.
- **MailerLite** exposes strong subscriber lifecycle fields and signed, retried webhooks. Campaign creation and scheduling are documented, but API sending requires a paid plan and API-supplied HTML requires its higher plan. No dedicated campaign test-send endpoint was found in the current public API reference.
- **Mailchimp** has complete campaign control, test and schedule actions, mature OAuth, reports, audience webhooks, and the strongest one-shot account export. Scheduling is paid-only, and all stored subscribed, unsubscribed, and non-subscribed contacts count toward paid contact limits.
- **Buttondown** exposes a compact API-first model for subscribers, draft/scheduled emails, test sends, granular events, and aggregate analytics. Its API is highly enumerable, but its public documentation does not describe a Mailchimp-style whole-account export or public OAuth flow.
- **Kit** can create or schedule broadcasts, manage subscribers, return aggregate broadcast statistics, and webhook subscriber changes. It has no documented dedicated API test-send operation or per-delivery campaign webhook surface. Its current plan/API eligibility must be confirmed in an account because current official pricing and integration pages describe that boundary inconsistently.

All five can be made replaceable only if Foundry CMS keeps a provider-neutral consent and suppression ledger. A provider export alone is not a sufficient Canadian anti-spam compliance record: it usually lacks the exact consent statement, legal identity shown at collection, policy/version context, and complete transition history.

The downstream decision should therefore choose between qualified adapters only after running the acceptance test in this document against real client-owned trial accounts. This research deliberately picks no winner.

## Required ownership boundary

### Foundry CMS owns

- Stable subscriber identity independent of email address and provider IDs.
- Normalized email address plus subscriber profile fields used by the site.
- Consent evidence: status, legal basis, scope/purposes, exact disclosure/version, collection surface, collected time, source URL or form ID, IP address when appropriate, and actor/import evidence.
- An append-only suppression history for unsubscribe, complaint, hard bounce, administrative suppression, erasure, and later lawful resubscription.
- Campaign source content, rendered HTML/text artifacts, subject, preview text, sender intent, audience definition, approval, content hash, requested schedule, and revision history.
- The logical send operation, idempotency key, provider mapping, current execution state, failure detail, and aggregate reporting snapshots.
- Provider configuration without secrets: adapter kind/version, account identity, audience/list mappings, verified sender/domain state, and webhook health.

### The provider is operationally authoritative for

- Its unsubscribe-link results, complaints, bounce classifications, delivery acceptance/failure, and provider-side suppression.
- Actual queueing, sending, cancellation, and completion state after a provider campaign is created.
- Provider message/campaign IDs and raw delivery/report values.

### Conflict rule

A negative delivery state always wins. An unsubscribe, complaint, hard bounce, or erasure received from either surface must suppress future sends locally before any later provider reconciliation. Neither a stale provider “active” value nor a routine subscriber upsert may reactivate a suppressed subscriber. Resubscription must be a separate, evidenced command.

The provider must not become the canonical campaign editor. Foundry sends fully rendered HTML and plain text where supported, stores the exact sent artifact, and treats provider templates only as optional delivery wrappers. A provider UI edit creates drift and must either be prohibited operationally or detected by comparing the provider content/hash before scheduling.

## Capability comparison

Legend: **Yes** = directly documented; **Partial** = usable with a material limitation; **Gap** = no adequate current public API evidence found.

| Capability | Brevo | MailerLite | Mailchimp | Buttondown | Kit |
|---|---|---|---|---|---|
| Subscriber create/update/list | Yes | Yes | Yes | Yes | Yes |
| Consent-related fields | Partial: custom attributes/consent groups; CMS proof still required | Strong partial: opt-in/subscription timestamps and IP fields | Partial: marketing permissions and member timestamps; CMS proof still required | Partial: source, form, IP, transitions; CMS proof still required | Partial: state, source/forms, tags/custom fields; CMS proof still required |
| Unsubscribe/bounce sync | Yes, marketing webhooks and contact blacklist state | Yes, signed webhooks for unsubscribe, bounce, complaint, and status changes | Yes, audience webhooks for unsubscribe/profile/bounce changes | Yes, subscriber events and rich subscriber status | Yes, subscriber unsubscribe/bounce/complaint webhooks |
| Draft campaign with CMS HTML | Yes, inline HTML | Yes, but inline HTML requires the higher plan | Yes, set campaign HTML/text content | Yes, HTML or Markdown body | Yes, HTML broadcast content |
| Test delivery by API | Yes, dedicated endpoint; 50/day | Gap in current campaign API reference | Yes, dedicated campaign test action | Yes, dedicated draft-send endpoint | Gap; test/preview exists in UI |
| Schedule/cancel by API | Yes | Yes | Yes; schedule is paid-only | Yes | Partial: create/update/delete draft or scheduled broadcast |
| Delivery events | Yes, marketing events | Yes: sent/open/click plus subscriber bounce/complaint | Partial: audience changes via webhooks; campaign delivery activity is primarily report polling/export | Yes, granular email events and webhooks | Partial: subscriber lifecycle webhooks; aggregate broadcast stats are polled |
| Aggregate analytics API | Yes | Yes | Yes | Yes | Yes |
| Subscriber portability | Yes, paginated API and async CSV export including subscription status | Yes, cursor API and UI CSV for every status | Yes, paginated API and comprehensive account export | Yes, paginated API includes positive and negative states | Yes, cursor API and UI bulk CSV |
| Campaign/report portability | Partial: enumerate campaigns/content/reports; no documented whole-account bundle | Partial: enumerate campaigns/reports and UI exports; no whole-account bundle | Strong: account export includes campaign HTML/text, audiences, events, assets, and aggregate/granular reports | Partial: enumerate emails, historical bodies, events, and analytics | Partial: enumerate broadcasts/stats plus UI CSV exports |
| Client connection model | API key; public third-party OAuth not currently available | User-bound API key; no public OAuth flow documented | Mature OAuth 2 for third-party accounts | API token; no public OAuth flow documented | API key for one account or OAuth for apps |
| Lowest useful current tier | Free has 300 sends/day and up to 100,000 contacts; validate campaign/API limits in trial | Paid required for API sending; higher plan required for inline HTML | Paid Essentials or higher required for scheduling | First 100 active subscribers free; analytics/tags/team features are add-ons | Newsletter plan advertises a generous free entry tier, but API/app eligibility needs an account test |

## Provider evidence and material caveats

### Brevo

Brevo documents REST resources for contacts, campaigns, reports, exports, and webhooks. A campaign can be created from inline HTML, a remote HTML URL, or a provider template; it can include a future `scheduledAt`. Separate endpoints send immediately or send a test to explicit addresses/a test list. The test endpoint is limited to 50 test emails per day.

Contact export is asynchronous CSV and can include mandatory fields, selected custom fields, list metadata, and email-marketing subscription status. Campaign content and statistics can be enumerated through the campaign endpoints. Marketing webhooks expose delivery and engagement events, but the adapter must deduplicate their at-least-once delivery.

Brevo's Free plan currently advertises 300 sends per day and storage for up to 100,000 contacts; Starter begins at USD $9/month and removes the daily limit. The trial-account acceptance test still needs to prove which marketing-campaign API actions and reporting/webhook features are available at the intended tier.

Handoff caveat: Brevo now documents OAuth 2, but states that OAuth apps are currently private and authorizable only by users in the same Brevo organization. A reusable CMS distributed to unrelated client accounts therefore cannot yet rely on Brevo public OAuth. The initial adapter would use a client-created, rotatable API key stored only in the client's secret store.

Sources:

- [Brevo API overview](https://developers.brevo.com/docs/getting-started)
- [Create an email campaign](https://developers.brevo.com/reference/create-email-campaign)
- [Send a test campaign](https://developers.brevo.com/reference/send-test-email)
- [Send a campaign immediately](https://developers.brevo.com/reference/send-email-campaign-now)
- [Get a campaign report](https://developers.brevo.com/reference/get-email-campaign)
- [Marketing webhooks](https://developers.brevo.com/docs/marketing-webhooks)
- [List contacts](https://developers.brevo.com/reference/get-contacts)
- [Export contacts](https://developers.brevo.com/reference/request-contact-export)
- [OAuth 2.0 and current private-app limitation](https://developers.brevo.com/docs/oauth)
- [Current plans](https://help.brevo.com/hc/en-us/articles/208589409-About-Brevo-s-pricing-plans)

### MailerLite

MailerLite's subscriber API exposes `active`, `unsubscribed`, `unconfirmed`, `bounced`, and `junk` states together with subscription/opt-in timestamps and IP fields. Upsert is intentionally non-destructive, and resubscribing an unsubscribed person requires an explicit `resubscribe` flag. This maps well to the “negative state wins” rule.

Its webhook surface includes subscriber create/update/unsubscribe/bounce/spam/deletion events and campaign sent/open/click events. Webhooks use HMAC-SHA256 signatures, require a response within three seconds, and are retried three times after failure. Campaign endpoints create, update, schedule/send, cancel, retrieve activity, and expose aggregate statistics.

The principal integration caveats are plan gates. Current pricing says API/MCP email sending is paid-only. The campaign reference says API-supplied HTML content requires the higher plan. No dedicated test-send action appears in the current campaign API reference; the provider UI supports test emails, but an automated CMS workflow would need a verified alternative such as a test-only group and a real campaign, or a product change from MailerLite.

MailerLite permits administrators to export all subscriber statuses and selected fields as CSV and export campaign activity/reports. Its API can enumerate subscribers, campaigns, content returned on campaign records, and campaign activity, but there is no documented one-request account bundle. API keys are permanently bound to the creating user and stop working when that user is removed, so the client must create the integration identity/key and rotate it during personnel changes.

Sources:

- [Subscriber API](https://developers.mailerlite.com/api/subscribers)
- [Campaign API](https://developers.mailerlite.com/api/campaigns)
- [Webhook events, retries, and signatures](https://developers.mailerlite.com/api/webhooks)
- [API authentication and user-bound key lifecycle](https://developers.mailerlite.com/getting-started)
- [Subscriber CSV export](https://www.mailerlite.com/help/how-to-export-subscribers)
- [Report export](https://www.mailerlite.com/help/how-to-analyze-and-export-reports)
- [Current pricing and API plan gate](https://www.mailerlite.com/pricing)

### Mailchimp

Mailchimp's Marketing API offers audience/member management, campaign create/update/content, send checklist, test, schedule/unschedule, send, reports, and OAuth 2. Audience webhooks can keep subscriptions, unsubscriptions, profile changes, and cleaned/bounced contacts synchronized. Campaign reporting and report-member endpoints provide aggregate and recipient activity; the adapter should not assume that every delivery event arrives as a webhook.

Mailchimp has the strongest documented bulk exit path in this shortlist. Its Account Exports API can package audiences split by subscribed/unsubscribed/cleaned state, campaign HTML and text, templates, assets, custom events, and aggregate/granular report activity. Only one export may run at a time and only one can be generated per 24 hours.

The Free Marketing plan currently allows 250 contacts, 500 monthly sends, and 250 daily sends. Scheduling requires Essentials or higher. Paid pricing counts subscribed, non-subscribed, and unsubscribed stored contacts, so retaining a large suppression population inside Mailchimp affects cost unless those contacts can safely be archived without damaging the portable local ledger.

Mailchimp supports third-party OAuth and explicitly recommends it when accessing another user's account. Tokens are tied to the authorizing user/role and are revoked if that user is removed, so onboarding and health checks must surface that dependency.

Sources:

- [Marketing API overview](https://mailchimp.com/developer/marketing/)
- [Campaign, content, test, schedule, report, and webhook endpoints](https://mailchimp.com/developer/marketing/api/list-webhooks/)
- [Audience synchronization with webhooks](https://mailchimp.com/developer/marketing/guides/sync-audience-data-webhooks/)
- [Account Exports](https://mailchimp.com/developer/marketing/docs/account-exports/)
- [OAuth 2 for other users' accounts](https://mailchimp.com/developer/marketing/guides/access-user-data-oauth-2/)
- [Current plan limits](https://mailchimp.com/help/about-mailchimp-pricing-plans/)
- [Scheduling is paid](https://mailchimp.com/help/send-regular-email/)

### Buttondown

Buttondown's API mirrors its compact newsletter domain closely. Subscriber records include source, creation, bounce/undeliverability/unsubscription dates and reasons, IP, form, tags, metadata, and transitions. New API subscribers use double opt-in by default; bypassing confirmation is an explicit per-subscriber action. The API can list all subscriber states for a portable snapshot.

Emails can be created as drafts, patched to scheduled with a `publish_date`, and test-sent to subscriber IDs or arbitrary recipients through a dedicated draft endpoint. Per-email aggregate analytics include recipients, deliveries, opens, clicks, temporary/permanent failures, unsubscriptions, and complaints. Granular email events and signed webhooks support reconciliation. Buttondown documents at-least-once webhook delivery, unordered events, deduplication by event ID, and automatic disablement after five consecutive failed events.

The first 100 active subscribers are currently free. Tags/segmentation, analytics, teams, and several other capabilities are separately priced add-ons, so the smallest usable tier depends on which reporting and audience functions the CMS promises. The public API permits enumerating subscribers, emails, historical bodies, events, and analytics, but no one-shot whole-account export was found. No public third-party OAuth flow was found; use a client-owned account and client-created token.

Sources:

- [Subscriber API model](https://docs.buttondown.com/api-subscribers-introduction)
- [List subscribers](https://docs.buttondown.com/api-subscribers-list)
- [Create subscriber and double opt-in behavior](https://docs.buttondown.com/api-subscribers-create)
- [Draft and schedule by API](https://docs.buttondown.com/drafting-emails-via-the-api)
- [Send a draft/test email](https://docs.buttondown.com/api-emails-send-draft)
- [Email analytics and granular events](https://docs.buttondown.com/retrieving-analytics-data)
- [Webhook delivery behavior](https://docs.buttondown.com/events-and-webhooks-introduction)
- [Current pricing](https://buttondown.com/pricing)

### Kit

Kit API v4 can list and manage subscribers, tags, custom fields, forms, and broadcasts. Creating a broadcast with `send_at: null` stores a draft; a future timestamp schedules it. Broadcast statistics expose recipients, opens, clicks, unsubscribes, status, and progress. Subscriber webhooks cover activation, unsubscribe, bounce, complaint, form/sequence/tag activity, and purchases.

The public API reference does not document a dedicated broadcast test-send endpoint. Kit's UI can send a test or preview, and its help material suggests sending a real broadcast to a one-person audience when a true personalized test is needed. The webhook catalog is subscriber-centric rather than a complete stream of per-recipient campaign delivery events, so aggregate reporting is primarily polled.

Subscriber data can be enumerated by cursor and exported through UI bulk actions. Broadcasts and selected analytics can be exported as CSV, but no complete account export comparable to Mailchimp's was found. OAuth is available for apps; API keys are intended for one account. Publishing a broadly installable App Store integration adds an approval process and current marketplace eligibility constraints.

Kit currently advertises a free Newsletter plan with a large subscriber allowance and unlimited broadcasts. Official pages are less clear about whether every API/app integration path is enabled on that plan: an earlier/current comparison surface lists API access, while current pricing distinguishes “apps & integrations” on paid plans. Treat free-tier API campaign control as unverified until the acceptance test runs in a newly created client-owned account.

Sources:

- [API v4 overview](https://developers.kit.com/api-reference/overview)
- [Create or schedule a broadcast](https://developers.kit.com/api-reference/broadcasts/create-a-broadcast)
- [Broadcast statistics](https://developers.kit.com/api-reference/broadcasts/get-stats-for-a-broadcast)
- [List subscribers](https://developers.kit.com/api-reference/subscribers/list-subscribers)
- [Webhook event catalog](https://developers.kit.com/api-reference/webhooks/create-a-webhook)
- [Authentication and OAuth/API-key roles](https://developers.kit.com/api-reference/authentication)
- [Subscriber bulk export](https://help.kit.com/en/articles/5026982-how-to-use-bulk-actions)
- [Broadcast export](https://help.kit.com/en/articles/2502503-the-kit-broadcasts-dashboard)
- [Current pricing](https://kit.com/pricing)

## Replaceable provider contract

The application layer should depend on a narrow `NewsletterDeliveryAdapter`, not a provider SDK. Names below describe behavior, not a required programming language.

```text
connect(config) -> AccountCapabilities
healthCheck() -> ProviderHealth

upsertSubscriber(subscriber, consentSnapshot, idempotencyKey) -> ProviderSubscriber
suppressSubscriber(subscriberId, reason, occurredAt, idempotencyKey) -> ProviderSubscriber
getSubscriber(providerSubscriberId) -> ProviderSubscriber
listSubscriberChanges(cursor) -> Page<ProviderSubscriber>

createCampaign(renderedCampaign, audience, idempotencyKey) -> ProviderCampaign
updateDraft(providerCampaignId, renderedCampaign, audience, expectedFingerprint) -> ProviderCampaign
sendTest(providerCampaignId, recipients, idempotencyKey) -> TestResult
schedule(providerCampaignId, sendAt, approvalHash, idempotencyKey) -> ProviderCampaign
cancel(providerCampaignId, idempotencyKey) -> ProviderCampaign
getCampaign(providerCampaignId) -> ProviderCampaign
getCampaignReport(providerCampaignId, cursor?) -> CampaignReport

registerWebhook(endpoint, eventKinds) -> WebhookRegistration
verifyWebhook(headers, rawBody) -> VerifiedProviderEvent
normalizeEvent(verifiedEvent) -> NewsletterEvent

exportSnapshot() -> ExportManifest
```

### Required normalized states

- Subscriber: `pending`, `active`, `unsubscribed`, `complained`, `hard_bounced`, `soft_bounced`, `suppressed`, `erased`.
- Campaign: `draft`, `testable`, `scheduled`, `queued`, `sending`, `sent`, `cancelled`, `failed`.
- Event: `subscribed`, `confirmed`, `unsubscribed`, `complained`, `bounced`, `delivered`, `opened`, `clicked`, `campaign_queued`, `campaign_sent`, `campaign_failed`.

An adapter may report an unsupported capability, but the default provider must pass all required acceptance tests. Optional features such as A/B tests, send-time optimization, automations, landing pages, and provider-hosted archives stay outside the v1 boundary.

### Reliability rules

- Record the local operation and idempotency key before the outbound call.
- Assume provider write APIs are not idempotent unless their documentation guarantees otherwise. On timeout, reconcile by stored provider ID, local correlation metadata, and content/audience fingerprint before retrying.
- Store raw webhook payloads only for a bounded diagnostic window; immediately store normalized durable events and deduplicate by provider event ID or a deterministic fallback key.
- Acknowledge a verified webhook quickly, then process asynchronously.
- Poll as a backstop for providers without complete campaign webhooks and run a periodic subscriber/suppression reconciliation for every provider.
- Never mark a send successful from an accepted API response alone. Advance through queued/sending/sent using provider state and report evidence.
- Block scheduling if the local approved content hash differs from the rendered artifact or provider draft fingerprint.
- Surface webhook disablement, expired/revoked keys, sender/domain verification failures, quota exhaustion, and report lag in the CMS.

## Canadian anti-spam requirements

For a commercial electronic message to a Canadian recipient, the CRTC describes three general requirements: prior express or implied consent, sender identification/contact information, and a working unsubscribe mechanism. Express consent requires an affirmative opt-in and does not expire, but it can be withdrawn. The sender bears the burden of proving consent. Unsubscribe requests must be acted on within 10 business days, and the sender's mailing/contact address must remain valid for at least 60 days after the message.

The CMS contract must therefore:

- Store the evidence needed to prove each express or implied consent, not merely `subscribed=true`.
- Version the consent disclosure and identify the legal person(s), purposes, collection surface, time, and available source evidence.
- Distinguish express consent from time-limited implied-consent bases and record the relevant relationship/expiry evidence.
- Include required identity, contact details, and a simple unsubscribe link in every rendered campaign.
- Suppress immediately on local or provider unsubscribe, well inside the statutory 10-business-day maximum.
- Preserve consent logs, campaign records, unsubscribe requests/actions, and relevant third-party/provider contracts as part of the client's compliance program.
- Keep the portable suppression ledger after a provider account is closed; deleting negative records can cause an unlawful re-import later.

This is product research, not legal advice. A Canadian legal review should approve the exact consent language, implied-consent policy, retention schedule, and client responsibilities before production use.

Sources:

- [CRTC: four main CASL requirements](https://crtc.gc.ca/eng/internet/anti/reg.htm)
- [CRTC: guidance on implied consent, withdrawals, and record keeping](https://crtc.gc.ca/eng/com500/guide.htm)
- [CRTC: CASL FAQ on proof, identification, unsubscribe, and retention](https://www.crtc.gc.ca/eng/com500/faq500.htm)

## Migration and export requirements

### Continuous portable snapshot

Do not wait for cancellation to discover export gaps. At least daily, retain a provider-neutral snapshot/manifest containing:

- All subscriber identities and states, including pending, unsubscribed, complained, bounced, suppressed, and erased tombstones where lawful.
- Profile fields, groups/tags, provider IDs, subscription/unsubscription/bounce timestamps and reasons.
- The CMS-owned consent and suppression ledger.
- Campaign source revision, exact sent HTML/text, audience rule and frozen recipient count, provider ID, schedule and actual send times.
- Aggregate delivery/open/click/unsubscribe/complaint/bounce metrics with retrieval time and provider definitions.
- Cursor/checkpoint, row counts, hashes, omissions, and API/version used.

Open and click metrics are provider-dependent and privacy-affected; preserve raw counts and definitions, but do not promise exact cross-provider comparability.

### Exit runbook

1. Put newsletter mutations in a visible maintenance mode; stop new scheduling.
2. Cancel or account for every future provider schedule and verify no campaign remains queued.
3. Reconcile webhooks and poll until the old provider has no unresolved sends.
4. Export all subscriber states, consent-related fields, suppressions, campaigns/content, and reports. Record provider limitations.
5. Compare provider counts by state with the CMS ledger; resolve every unexplained difference.
6. Create the new provider in the client's account, verify its sending domain, sender identity, unsubscribe behavior, and webhook.
7. Import only lawfully active subscribers as sendable. Import/provider-suppress negative states where supported and always keep them suppressed in the CMS.
8. Map old/new provider IDs without changing stable CMS subscriber/campaign IDs.
9. Run test sends, rendering checks, webhook signature/retry tests, unsubscribe and bounce tests, and aggregate-report reconciliation.
10. Switch the adapter; keep the old provider read-only through a defined rollback window.
11. Prove that a duplicate campaign cannot send from both providers, then revoke old credentials and document final export hashes.

Migration is not complete until active, unsubscribed, complaint, and hard-bounce counts reconcile; all future schedules are accounted for; consent evidence remains readable; and a test unsubscribe at the new provider suppresses the CMS record.

## Provider acceptance test for issue #5

Run this unchanged against a new client-owned account at the intended paid/free tier:

1. Connect without sharing the client's password; rotate/revoke the credential and observe CMS health.
2. Create a pending subscriber with consent metadata, confirm it, update it, unsubscribe through a provider link, and verify the CMS suppresses it.
3. Attempt an ordinary upsert of that address and prove it cannot resubscribe.
4. Generate a campaign entirely in Foundry, create/update the provider draft, and compare stored/rendered/provider content fingerprints.
5. Send a test through the API to two explicit addresses without making the campaign live.
6. Schedule in a non-UTC timezone, cancel, reschedule, and confirm exact UTC execution intent.
7. Force or simulate delivery, soft bounce, hard bounce, complaint, unsubscribe, open, and click; record webhook coverage, signatures, ordering, retries, and polling gaps.
8. Compare aggregate provider results with normalized CMS metrics and document metric definitions/lag.
9. Exceed or safely simulate rate/quota limits and prove there is no false success or duplicate send.
10. Export every subscriber state, consent-related field, campaign HTML/text, schedule, and report; verify counts and hashes against the API.
11. Hand the account to a different client administrator, remove the original integration user, rotate credentials, and restore service from the runbook.
12. Migrate the fixture to a second adapter and prove that suppressions and consent evidence survive without resending or reconfirming unlawfully.

Any provider that cannot perform steps 2, 4, 5, 6, 7 (with documented polling fallback), 10, and 12 should not be the default v1 adapter. A manual provider-UI test send or provider-only consent record does not satisfy the boundary.

## Questions left for the downstream decision

- Is public OAuth a v1 requirement, or is a client-created API key acceptable for isolated client-owned deployments?
- Is a dedicated API test-send endpoint mandatory? This directly affects MailerLite and Kit.
- What is the minimum affordable tier at the first client's real subscriber/send volume after required API HTML, scheduling, analytics, segmentation, and team features are included?
- Which providers pass the live webhook retry/signature and export fidelity tests?
- Is complete granular delivery-event ingestion required, or are suppression webhooks plus aggregate report polling sufficient?
- Which provider's sender/domain verification and account-handoff experience is simplest for a non-technical client?

Those are selection questions for [#5](https://github.com/Galen-Humber-Foundry/foundry-cms/issues/5), not conclusions of this research ticket.
