# ADR-0005: Human authentication and authorization boundary

- **Status:** Accepted
- **Date:** 2026-07-26

## Context

Each Foundry CMS installation is self-hosted in one client's Cloudflare account.
The public site and private CMS share one deployment, while the dashboard,
application API and draft previews must remain private. The installation must
continue without Humber Foundry infrastructure, credentials or default access.

Cloudflare Access is the outer identity-aware proxy, but it is not the
application authorization database. Foundry must independently verify every
Access assertion, resolve it to an installation-local user and authorize each
command from current D1 state. D1 must also remain authoritative when Access API
synchronization is delayed or unavailable.

V1 has two human roles:

- Owners administer users, integrations, credentials, subscriber-level access
  and bulk-send authorization.
- Editors manage and publish site and blog content and prepare campaigns, but
  cannot administer access, see subscriber identities or authorize bulk sends.

This decision resolves
[issue #12](https://github.com/Humber-Foundry/foundry-cms/issues/12). Non-human
MCP and integration identities remain outside this ADR.

The Cloudflare contracts used here are its current documentation for
[application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/),
[Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/),
[application-token claims](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/),
[JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
and
[independent MFA](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/independent-mfa/).
Provisioning tests, rather than this documentation alone, remain the release
evidence for each installation.

## Decision

### Access application and path policy

Provision one self-hosted Cloudflare Access application per installation with a
single audience and explicit entries for:

- `/dash` and `/dash/*`
- `/api/foundry-cms` and `/api/foundry-cms/*`
- `/__foundry/preview` and `/__foundry/preview/*`

The rest of the site remains public. No protected entry may use an Access
`Bypass` rule, including CORS preflight. A missing Access application,
authentication adapter or required route binding is a deployment failure, and
the application layer still rejects every request without a valid assertion.
Production must expose these namespaces only through the canonical
Access-fronted hostname. Disable public `workers.dev`, branch-preview and
deployment-preview aliases, or place their equivalent protected paths behind an
Access application with the same audience and policy before release.

Provider callbacks use a separate public integration namespace and never sit
under `/api/foundry-cms`. The Brevo transactional callback is
`/api/integrations/brevo/webhooks/transactional`; it verifies its exact bearer
before parsing the payload or accessing D1. Installation verification requires
that an unauthenticated callback reaches the application and returns `401`
while every human CMS API probe still receives an Access challenge.

The default Allow policy:

- includes only exact, Owner-approved email addresses;
- requires the configured One-Time PIN identity provider;
- contains no domain-wide, all-valid-email or Everyone rule; and
- denies every non-matching identity by default.

The installer configures an eight-hour Access application session as a starting
default. Cloudflare remains the only login-session authority. If a client later
changes its Cloudflare session or SSO settings, Foundry honors the expiry of the
valid Access assertion and applies no independent maximum. Foundry implements
neither a login cookie nor a "remember me" credential.

For the browser-only application, keep the Access cookie HttpOnly, enable the
binding cookie where the client's enabled Cloudflare products are compatible,
and leave the cookie path attribute disabled so one application cookie works
across all three protected namespaces. Any binding-cookie exception must be
reported by provisioning and covered by the installation's security check.

### JWT validation and request principal

Every protected request uses the `Cf-Access-Jwt-Assertion` header. The
authentication adapter accepts it only when all of these conditions hold:

- The algorithm is exactly `RS256`, the `kid` resolves to the installation's
  configured Cloudflare Access JWKS, and the signature verifies.
- `iss` exactly equals the configured HTTPS Access team domain.
- `aud` contains the configured audience of this installation's one Access
  application.
- `type` is `app`.
- `exp`, `nbf` and `iat` are valid with no more than 60 seconds of clock
  tolerance.
- `sub` and the IdP-verified `email` claim are present and structurally valid.
- `(iss, sub)` resolves to an active installation-local membership in D1.

The adapter follows Cloudflare's rotating JWKS rather than pinning a
certificate. It caches usable keys, refreshes them periodically and performs
one immediate refresh for an unknown `kid`. A cached key may bridge a temporary
JWKS outage for at most 24 hours. Once no non-stale usable key exists, requests
fail closed with a service-unavailable result and no command executes.

Missing configuration or assertions, unsupported algorithms, malformed claims,
unknown identities, expired assertions, issuer or audience mismatches, and
verification failures all fail closed. Authentication middleware creates a
request-scoped principal; it never forwards the raw JWT into domain commands,
logs, audit records or browser data.

### Installation-local users and authorization

D1 stores separate records for:

- a stable internal user UUID;
- one or more external identity bindings;
- installation membership and current Owner or Editor role;
- invitations and their lifecycle;
- Access synchronization work; and
- append-only audit events.

An external identity binding is keyed by `(issuer, subject)`, using the
validated Access `iss` and `sub`. Normalized email is an invitation and contact
attribute, not the authorization key. A Cloudflare identity that is removed and
re-added with a new `sub` does not silently inherit the old membership.

Every application command reloads active membership and role from D1. There is
no Foundry authentication session or cached authorization grant. Removal,
suspension and role changes therefore take effect on the next command even when
the user's Access cookie remains valid.

Authorization lives in the shared application layer, not in route components:

- Owners receive only the explicit Owner capabilities defined by the domain
  command.
- Editors receive only explicit Editor capabilities.
- Unknown, expired, suspended and removed memberships receive no capability.
  A validated identity matching one claimable invitation may invoke only the
  invitation-claim transition; it receives no CMS domain capability until that
  transaction activates membership.
- UI visibility is convenience only; the server authorizes every command.
- Non-human credentials cannot enter this human-authentication adapter.

### Browser request integrity

All human mutations use `POST`, `PUT`, `PATCH` or `DELETE` with an allowed JSON
content type. `GET` and `HEAD` remain side-effect free.

Each mutation must carry:

- an `Origin` equal to the installation's configured canonical origin; and
- a short-lived signed CSRF token bound to the validated Access identity,
  application audience and Access identity nonce.

The CSRF token is request-integrity evidence, not an authentication session.
Foundry sends no permissive credentialed CORS response. Missing, `null`,
cross-origin or malformed origins, absent or invalid CSRF tokens, and unexpected
content types fail before command dispatch. Security headers and CSP must keep
the dashboard and same-origin preview iframe within this boundary.

### Invitation state machine

An Owner invites an exact email address as either Owner or Editor. Invitations
expire after seven days and move through these durable states:

1. `pending_access_sync` — D1 has recorded the invitation, but it grants no CMS
   authority and no email is sent.
2. `pending_acceptance` — the Access allowlist update has been read back and
   verified; the invitation email may now be delivered.
3. `active` — the invited address completes a valid Access login, the exact
   normalized email matches, `(iss, sub)` is bound to the internal user and the
   membership becomes active in one D1 transaction.
4. `revoked` or `expired` — the invitation can no longer be claimed and its
   Access allowlist entry is removed unless another active membership or
   invitation still requires that address.

The emailed URL identifies the invitation but is not itself an authorization
capability. Claiming always requires a verified Access assertion for the exact
invited email. Resend rotates delivery metadata without extending the expiry
unless the Owner explicitly renews the invitation. Duplicate active membership
and ambiguous email claims are rejected for review.

If invitation email delivery fails after Access synchronization, the
invitation stays pending acceptance, shows the delivery failure to the Owner
and can be retried or copied as a sign-in link. No secret is exposed in that
link.

### First-Owner bootstrap

Guided provisioning records the installer's exact email as a one-use bootstrap
Owner invitation and follows the same Access synchronization and verified-login
claim path. The provisioning operator authenticates to the client-owned
Cloudflare account; it does not mint a CMS password or durable bootstrap bearer
token.

The installation exposes only the narrow bootstrap claim while no Owner has
ever been activated. The first valid claim creates the internal identity
binding and Owner membership transactionally, writes the audit event and
permanently closes bootstrap mode. A failed or abandoned bootstrap can be
resumed by provisioning, and a completed installation can use only the normal
invitation or Owner-recovery paths.

### Changes, removal and last-Owner safety

Role changes are transactional D1 operations and do not depend on an Access API
call. Removing a user first marks the D1 membership suspended, invalidates
pending invitations for that identity and commits an Access-removal outbox
item. Application authorization stops immediately; Cloudflare cleanup may
complete later.

Historical authorship, published Git attribution and audit records remain.
Removal does not delete or silently reassign drafts. An Owner can explicitly
assign unfinished work to another active user.

D1 enforces the invariant that at least one active Owner remains. The final
Owner cannot be removed, suspended or demoted, and an Owner cannot remove or
demote themselves when they are the last active Owner. Destructive membership
actions require a clear confirmation naming the affected user and effect.

An authenticated user may replace their own login email through a verified
new-email flow while preserving the internal UUID. Owner-initiated replacement
without the existing user's participation creates a new user instead of
rewriting another person's identity history.

### Access synchronization and client-owned credential

D1 is authoritative; Cloudflare Access is an outer gate synchronized from it.
The runtime uses one client-owned API token stored only as a Worker secret. It
is restricted to the installation's Cloudflare account and the minimum
`Access: Apps and Policies Write` permission needed to maintain this
application's exact-email rules. It receives no Worker deployment, D1, zone,
DNS, billing, identity-provider administration or unrelated provider
permission.

Provisioning credentials may create the Access application and identity
provider during an interactive setup, but they are not retained by the
installation. The narrower runtime token is separately rotatable and revocable.
Its value never enters D1, source control, logs, exports, browser responses or
audit records.

Access synchronization uses a transactional D1 outbox, stable idempotency keys,
read-after-write verification, bounded exponential retries and an observable
health state:

- Grants fail closed in `pending_access_sync`; an invitation is not announced
  as ready until Cloudflare confirms it.
- Revocation and suspension take effect in D1 before Cloudflare cleanup, so an
  Access outage cannot preserve application authority.
- A failed or revoked runtime token blocks new grants, displays degraded
  authentication health to Owners and keeps retryable work; it does not restore
  removed membership.
- Reconciliation compares the desired exact-email set derived from active
  memberships and claimable invitations with the actual application policy.
  It repairs drift toward D1 and never imports an unexpected Access entry as a
  CMS member.

### MFA and identity-provider variation

Email OTP is the small-client compatibility default, not a claim that email
alone is multi-factor authentication. Provisioning and handoff strongly
recommend Cloudflare independent MFA and guide enrollment in an authenticator
app or security key. The Owner dashboard keeps a visible warning while MFA is
not enforced.

MFA remains optional by default to avoid making a lost second factor a mandatory
small-client lockout path. A client can enforce independent MFA at the Access
application or policy, or require MFA through a supported IdP. Where Cloudflare
can recognize IdP-performed MFA, configuration should avoid an unnecessary
duplicate challenge.

Clients may replace OTP with a client-owned OIDC, SAML or supported first-party
IdP without changing Foundry's assertion validator or role model. Cloudflare
Access remains the only accepted issuer, exact approved emails remain the outer
eligibility set, and D1 remains authoritative for roles. Foundry does not
authorize from IdP groups or best-effort custom JWT claims.

An IdP migration is explicit and staged. Identity bindings are never silently
reassigned by matching an untrusted or newly observed email. Active users may
verify and bind a replacement identity; otherwise an Owner or the recovery flow
must approve the rebind and the event is audited.

### Owner recovery

Provisioning strongly prompts the installer to add a second Owner but does not
require one.

If Owners are locked out, a person with administrative control of the client's
Cloudflare account can run a guided operator command that:

1. identifies the exact installation and D1 database;
2. authenticates directly to the client-owned Cloudflare account;
3. displays the existing Owner state and requires explicit confirmation;
4. creates or rebinds the requested replacement Owner;
5. synchronizes and verifies the exact Access allowlist entry; and
6. writes an append-only recovery audit event before reporting success.

The command is limited to identity recovery and cannot edit content, publish,
read subscriber data or mint non-human credentials. It never depends on a
Humber Foundry account or retained credential. Cloudflare account control is
already infrastructure and database control; the recovery path makes that fact
explicit, narrow and observable rather than adding a hidden web backdoor.

### Audit and retention

Foundry writes append-only D1 audit events for:

- invitation creation, renewal, claim, expiry and revocation;
- membership activation, suspension, removal and role change;
- successful identity binding and explicit identity rebind;
- denied application authorization, subject to abuse-safe rate limiting;
- Access synchronization attempts, drift, repair and credential-health changes;
- MFA configuration health observed during provisioning or diagnosis;
- Owner recovery attempts and outcomes; and
- every Owner-only command and resulting state transition.

Each record contains a unique event and request ID, timestamp, internal actor
identity or recovery actor type, action, target, outcome, reason code and
non-secret before/after state needed to explain the change. It does not contain
JWTs, OTPs, CSRF tokens, API-token material, raw request bodies or full IP
addresses.

The default retention is 24 months, with export before expiry and a
client-configurable longer period. Published Git attribution remains governed
by repository history. When privacy obligations require removing contact
details, the stable internal actor ID and non-identifying security event may
remain while email and display attributes are redacted through an audited
operation.

### Release and security tests

Human authentication is not production-ready until automated tests and a real
client-owned Cloudflare acceptance run prove:

- every protected base path and descendant is gated while public routes remain
  public;
- missing adapters, headers and configuration fail closed;
- signature, algorithm, key rotation, issuer, audience, type, time and claim
  validation reject all malformed and confused tokens;
- JWKS refresh, bounded stale-key behavior and outage recovery behave as
  specified;
- unknown, invited, expired, suspended and removed identities cannot execute
  commands;
- Owner and Editor capability matrices deny every cross-role command;
- session-duration changes in Cloudflare carry through without a second
  Foundry expiry;
- Origin, CSRF, method, content-type and CORS controls prevent cross-site
  mutations;
- invitations, expiry, resend, revocation, exact-email claim and duplicate
  claim are deterministic and idempotent;
- first-Owner bootstrap is one-use, resumable before activation and unavailable
  after the first successful claim;
- grant synchronization fails closed, revocation is immediate in D1, and
  reconciliation repairs Access drift without creating membership;
- the last-Owner invariant and client-controlled recovery both work;
- OTP, optional independent MFA and at least one client IdP work without
  changing D1 authorization;
- the runtime API token has only the documented account and permission scope,
  can be rotated, and produces visible degraded health when revoked; and
- audit records are complete, correctly redacted, exportable and retained as
  configured.

Tests must include direct-origin and route-misconfiguration attempts, replayed
and stale requests, concurrent invitation/removal operations, Access API
timeouts and partial responses, an unknown signing key, manual key rotation,
revoked credentials and recovery from interrupted synchronization.

## Consequences

- Clients get one familiar Cloudflare login across dashboard, API and previews,
  with no second Foundry session that can expire or be stolen independently.
- Exact-email OTP keeps initial onboarding accessible; independent MFA and
  client IdPs can strengthen it without changing the application model.
- D1 removal is immediate even during a Cloudflare API outage, while new access
  never becomes usable until both layers agree.
- Stable internal users preserve attribution through email and IdP changes
  without treating an email address as permanent identity.
- The runtime requires an account-scoped Access policy token. It is narrow by
  permission but still powerful over Access applications in that account, so
  rotation, health reporting, secret isolation and a dedicated client account
  boundary matter.
- Seven-day invitations, visible synchronization states, backup-Owner guidance
  and guided recovery add product work but make lockout and partial failure
  understandable to a non-technical Owner.
- Per-command D1 authorization and append-only audit writes add database work;
  this is accepted in exchange for immediate revocation and one authorization
  model across future interfaces.

## Alternatives considered

- **Use Cloudflare Access as the membership and role database** — rejected
  because application commands still require stable local roles, immediate
  revocation, invitation state, audit history and independence from IdP claims.
- **Use email as the user primary key** — rejected because addresses change and
  can be recycled; Cloudflare `sub` can also change after removal and re-addition.
- **Create a Foundry login session or remember-me cookie** — rejected because it
  would create a second authentication authority with conflicting expiry,
  revocation and recovery behavior.
- **Use separate Access applications for dashboard, API and previews** —
  rejected because the same humans and membership policy use all three;
  multiple audiences and cookies add synchronization and validation failure
  modes without useful isolation.
- **Allow an email domain or all OTP users** — rejected because domain
  membership and possession of any valid email are broader than an Owner's
  explicit invitation.
- **Activate D1 membership before Access synchronization** — rejected because a
  grant must not be reported as usable until both gates agree.
- **Make MFA mandatory for every default installation** — rejected because the
  smallest clients need a recoverable low-friction default; the product instead
  makes MFA visible, guided and enforceable by the client.
- **Retain a Humber Foundry recovery account or credential** — rejected because
  it violates client ownership, independent revocation and the no-shared-
  runtime boundary.
- **Automatically import Access or IdP users and groups** — rejected because
  external eligibility is not application authorization and synchronization
  drift must not create CMS authority.
