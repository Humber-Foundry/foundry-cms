# ADR-0050: Whole-path browser checks run against the built Worker and sign in through an Access team that exists for one run

- **Status:** Accepted
- **Date:** 2026-11-07
- **Issue:** [#259](https://github.com/Humber-Foundry/foundry-cms/issues/259)
- **Related:** [ADR-0001](ADR-0001-default-form-handling-adapter.md),
  [ADR-0005](ADR-0005-human-authentication-authorization-boundary.md),
  [ADR-0044](ADR-0044-contact-form-component-and-form-to-inbox-contract.md),
  [ADR-0049](ADR-0049-dashboard-documents-carry-a-content-security-policy.md)

## Context

The browser checks in `scripts/verify-*-browser.mjs` run `next dev`. In
development the dashboard signs in a built-in local Owner, no D1 database is
bound, and every Messages read returns an empty result (`readMessages` in
`apps/reference-site/src/public-form-messages-runtime.ts`). So no browser check
could follow a visitor's action all the way to the dashboard. ADR-0044 had to
split "a visitor's message appears in Messages" into a browser half and a
route-test half. The v1 release gate (#63) needs whole-path proof.

A whole-path check needs three things that `next dev` does not have:

1. The built Worker, with the bindings in `wrangler.jsonc`, a D1 database
   with every migration applied, and R2.
2. A signed-in member. The deployed dashboard trusts only a Cloudflare Access
   assertion: an RS256 token whose issuer is the installation's Access team,
   whose key is in that team's key set at
   `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, and whose
   `(iss, sub)` is an active membership in D1 (ADR-0005).
3. A Turnstile check the form route accepts.

The second need is the risky one. Anything that signs a person in without
Cloudflare Access is a backdoor if a deployed Worker can be made to accept it.

## Threat model

What must never happen: a deployed Worker treats a request as a signed-in
member when Cloudflare Access did not sign that member in.

Ways the harness's sign-in could reach a deployment:

- **A switch in Worker code.** For example, "accept a test token when
  `FOUNDRY_TEST_MODE` is set". One wrong variable in a deploy, or one copied
  `.dev.vars` file, opens the dashboard to anyone who knows the test token.
- **A test key or test team that a deployment trusts.** For example, a fixed
  harness key pair in the repository. This repository is public, so a fixed
  private key is a published key. If a deployment's settings ever named the
  harness's issuer, anyone could sign in.
- **A test entry point that ships.** For example, a harness-only Worker entry
  that a build or deploy could pick up by mistake.
- **A leaked assertion.** A token the harness made, sent to a third party, and
  replayed against a deployment.

## Decision

### No Worker code knows about the harness

The harness serves the same build a deploy uploads: `custom-worker.ts`
bundled by Wrangler from `wrangler.jsonc`. There is no test mode, no test
entry point and no test setting in the Worker. The Worker validates the
harness's Access assertion with exactly the production code path in
`src/access-identity.ts`: algorithm, key, issuer, audience, type, times,
claims and the D1 membership.

### The harness is a Cloudflare Access team for one run

`createAccessStandIn` in `scripts/lib/worker-harness.mjs` makes, for each run:

- a random team, so the issuer is
  `https://foundry-harness-<16 random hex digits>.cloudflareaccess.com`;
- a random 256-bit audience;
- a new RS256 key pair. The private key exists only in the harness process's
  memory. It is never written to disk, logged or sent anywhere.

The harness puts the run's member in the fresh local D1 database as an active
Owner, keyed by that issuer and a random subject. It gives the Worker the
issuer and the audience as ordinary settings.

The Worker trusts the run's key for one reason only: when the Worker asks
`<issuer>/cdn-cgi/access/certs` for the team's keys, the harness answers that
request with the run's public key. The harness can answer it because it serves
the Worker with Wrangler's local runtime and passes it an `outboundService`.
That function receives every request the Worker sends out. A deployed Worker
has no such function. Its request for the team's keys goes to Cloudflare.

So, against each threat above:

- **Switch in Worker code** — there is none. No setting, alone or together
  with others, makes a deployed Worker accept the harness's assertion. A
  deployment that copied every harness setting would still fetch the team's
  keys from Cloudflare, which has never seen the run's key.
- **Trusted test key or team** — the key and the team name are new on every
  run, and the private key never leaves the process. There is nothing fixed to
  publish, copy or trust.
- **Test entry point** — there is none. The build is the deploy build.
- **Leaked assertion** — the signed-in page adds the assertion only to its own
  loopback origin's Access paths (`/dash`, `/api/foundry-cms`,
  `/__foundry/preview`), as Access does. Even a leaked assertion names a team
  and audience that no deployment uses, and is signed by a key no deployment
  trusts.

The harness also refuses every other request the Worker sends out, except the
Turnstile siteverify call below. A check therefore cannot reach a real provider
account, and it can read the list of refused requests.

### A test proves that a deployed build refuses it

`scripts/verify-access-stand-in-refused.mjs` runs in Product CI after the
Worker build. It:

1. makes the deploy bundle with `wrangler deploy --dry-run` and fails if any
   harness marker is in it;
2. starts the built Worker with the harness's answer for the team's keys and
   requires the assertion to open `/dash/forms`. This is the control: it shows
   the assertion is otherwise valid;
3. starts the same build, with the same settings and the same member in D1,
   but lets the key request go out to the network as a deployed Worker's does,
   and requires `/dash/forms` to be refused (404 for keys that do not verify,
   or 503 when the key request fails);
4. starts it once more with a team key set the harness does not hold, which is
   what Cloudflare serves for a real team, and requires a 404.

### Turnstile uses Cloudflare's test pair, and siteverify runs for real

The Worker gets Cloudflare's published test site key and test secret, which
always pass (see
[Test your Turnstile implementation](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)).
The visitor's browser runs the real widget from Cloudflare, which hands the
form the dummy token. The Worker's siteverify request goes to Cloudflare with
the test secret, and Cloudflare's verdict decides.

Cloudflare documents that a test-secret answer always names `example.com` and
carries no `action`. ADR-0001 requires the Worker to check both against its
own values, and the Worker does. So when Cloudflare reports success, the
harness fills in the hostname and the action that a real widget on this site
would report, and passes the answer on. When Cloudflare reports failure, the
harness passes that on unchanged. The Worker's hostname and action check still
runs, but it compares the Worker's values with values the harness chose. It
proves the check runs on the answer, not what a real widget reports.

### The dashboard pages below `/dash` receive the verified identity

The harness found a production fault. The Worker's identity boundary verified
the Access assertion only for `/dash` and `/dash/`. Every page below it, such
as `/dash/forms`, reached Next with no verified identity and answered 404,
even for a signed-in Owner. ADR-0005 protects `/dash/*` as well as `/dash`, so
this was a defect, not a decision.

The boundary now verifies the assertion for every path below `/dash` too, and
passes the verified identity on. When the assertion is missing or invalid, a
page below `/dash` still goes on with no identity and answers 404 itself, so
its 404 keeps the dashboard Content Security Policy that ADR-0049 records.
When the Access keys cannot be fetched, a page below `/dash` gets the same 503
as `/dash`.

### One helper starts and stops everything

`withWorkerHarness(options, check)` builds the Worker (unless told the current
source is already built), prepares the database in a new directory under the
system temporary directory, serves the Worker on `https://127.0.0.1:<port>`,
launches Chromium and gives the check an origin, a visitor page and a
signed-in page. It stops the browser and the Worker and removes the directory
when the check passes, fails or is interrupted.
`scripts/verify-worker-harness-cleanup.mjs` proves this in Product CI for a
failed and an interrupted check. `docs/operations/whole-path-browser-checks.md`
explains how to write a check.

The Worker is served over HTTPS with Miniflare's built-in local certificate,
because the form route and the mutation checks require an `https:` canonical
origin. The browser accepts that certificate. The page origin is the
canonical origin the Worker checks, so the route's origin check runs for real.

## Consequences

- `scripts/verify-contact-form-whole-path-browser.mjs` sends a message from
  the public home page and reads it, the unread line and the "1 message
  received." count on `/dash/forms` as a signed-in Owner. It runs in Product
  CI after the Worker build and replaces the two-halves proof that ADR-0044
  describes for that path. The two halves stay; they are faster and cover
  more cases.
- The whole-path check and the refusal check need the network: the browser
  loads the Turnstile widget from Cloudflare, siteverify runs at Cloudflare,
  and the refusal check's step 3 sends one key request for a team that does
  not exist. None of these touches a Cloudflare account.
- The harness does not prove the Turnstile hostname and action that a real
  widget reports. Only a real site key can do that, on an installation.
- The harness does not prove Cloudflare Access itself: the login, the cookie
  and the policy. Installation acceptance still does (ADR-0005).
- The dashboard Overview at `/dash` still answers 404 in the harness, because
  it opens a draft workspace, which needs content-publication settings the
  harness does not give. A check that needs it must add those settings.

## Alternatives considered

- **A test mode in the Worker, turned on by a setting.** Rejected. It rests on
  one setting a deploy could carry by mistake, which is exactly the backdoor
  the threat model rules out.
- **A harness-only Worker entry that wraps `custom-worker.ts` and replaces
  `fetch` for the key request.** Rejected. It puts harness code in the
  repository's Worker source, where a build or deploy could pick it up, and it
  tests a different entry point from the one that ships.
- **A fixed test key pair in the repository.** Rejected. The repository is
  public, so the private key would be public, and a deployment that ever named
  the harness's issuer would accept anyone.
- **Pointing the issuer at a local key server.** Rejected. It needs the Worker
  to accept a non-Cloudflare or non-HTTPS issuer, which weakens the production
  validator that ADR-0005 requires.
- **Answering siteverify entirely in the harness.** Rejected in favour of
  forwarding to Cloudflare: forwarding proves the widget's token and the
  Worker's request reach Cloudflare and pass, and only the two fields
  Cloudflare documents as fixed are filled in.
- **Relaxing the Worker's Turnstile action check for test keys.** Rejected. It
  changes ADR-0001's production rule to suit a test, and a deployment carrying
  the test secret by mistake would then accept every dummy token.
