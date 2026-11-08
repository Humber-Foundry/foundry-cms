# Whole-path browser checks

A whole-path check follows one action from the public site to the dashboard
against the built Worker. It uses a real local D1 database, local R2, the
real Turnstile widget and a signed-in Owner. Use one when the proof you need
crosses the visitor side and the dashboard side, for example "a visitor's form
message appears in Messages".

The other browser checks in `scripts/verify-*-browser.mjs` run `next dev`.
There the dashboard signs in a built-in local Owner and reads no database, so
they cannot prove a whole path. Keep using them for layout and interaction
checks; they are faster.

ADR-0050 records how the harness works and why its sign-in cannot open a
deployed Worker.

## What the harness gives a check

`scripts/lib/worker-harness.mjs` exports `withWorkerHarness(options, check)`.
It:

1. builds the Worker with `npm run build && npm run build:worker`, unless
   `options.build` is `false`;
2. makes a new directory under the system temporary directory, applies every
   migration in `apps/reference-site/migrations` to a local D1 database there,
   and adds one active Owner;
3. serves the built Worker on `https://127.0.0.1:<port>` with the bindings in
   `apps/reference-site/wrangler.jsonc` and random secrets for this run;
4. launches headless Chromium;
5. calls `check(harness)`;
6. closes the browser, stops the Worker and removes the directory, whether
   the check passed, failed or was interrupted. If a clean-up step fails, a
   check that passed fails too.

`harness` has:

- `origin` — the Worker's origin. It is also the site's canonical origin, so
  the form route's origin check passes for a page loaded from it.
- `newVisitorPage({ viewport })` — a page with no Access session.
- `newSignedInPage({ viewport })` — a page signed in as the Owner. It sends
  the Access assertion only on `/dash`, `/api/foundry-cms` and
  `/__foundry/preview`, as Cloudflare Access does.
- `refusedOutbound` — every request the Worker tried to send out that the
  harness refused. The harness answers only the Access key request and
  Turnstile siteverify. Fail the check if this list is not empty, unless the
  check expects a refusal.

`options.turnstileAction` is the Turnstile action of the form the check sends,
for example `contact`. Cloudflare's test answer carries no action, so the
harness adds this one. Use the action the form's status request reports.

## Writing a check

Copy the shape of `scripts/verify-contact-form-whole-path-browser.mjs`:

```js
import { withWorkerHarness } from "./lib/worker-harness.mjs";

try {
  await withWorkerHarness(
    {
      build: !process.argv.includes("--reuse-build"),
      turnstileAction: "contact",
    },
    async (harness) => {
      const visitor = await harness.newVisitorPage();
      await visitor.goto(`${harness.origin}/`);
      // ...act as the visitor...
      await visitor.context().close();

      const owner = await harness.newSignedInPage();
      await owner.goto(`${harness.origin}/dash/forms`);
      // ...read what the owner sees...
      await owner.context().close();

      if (harness.refusedOutbound.length > 0) {
        throw new Error(
          `worker_sent_unexpected_requests:${harness.refusedOutbound.join(", ")}`,
        );
      }
    },
  );
  process.stdout.write("my whole path: ok\n");
} catch (error) {
  process.stderr.write(`${error?.stack ?? String(error)}\n`);
  process.exitCode = 1;
}
```

Rules:

- Throw at the first value that does not match, with a short error code and
  the value seen.
  Set `process.exitCode`; do not call `process.exit` inside the check, or the
  harness cannot clean up.
- Do not read a refused response's body with Playwright's `response.text()`.
  It can wait forever after the page has moved on. Check the status instead.
- The form route files a message sent less than two seconds after the form
  appeared as suspected spam. Wait at least that long before sending, as a
  person would.
- Each run starts with an empty database except for the Owner. Do not depend
  on another check's data.
- Use unique text in what you send, so the check finds its own record.
- Do not add a setting, a code path or an entry point to the Worker for a
  check. If a check needs a setting the harness does not give, add it to
  `workerSettings` in the harness, with a random value where it is a secret.

## Running a check

```sh
node scripts/verify-contact-form-whole-path-browser.mjs
```

This builds first and takes about a minute on a warm machine. If you have
just built the current source:

```sh
npm run build && npm run build:worker
node scripts/verify-contact-form-whole-path-browser.mjs --reuse-build
```

The run needs the network: the browser loads the Turnstile widget from
Cloudflare, and siteverify runs at Cloudflare. It touches no Cloudflare
account.

Set `TMPDIR` to put the database directory on another disk. Nothing is left
there after the run.

## In Product CI

Product CI builds the Worker once, then runs `npm run verify:whole-path`.
That script runs:

- `node scripts/verify-access-stand-in-refused.mjs`, which proves a deploy
  build refuses the harness's sign-in;
- `node scripts/verify-worker-harness-cleanup.mjs`, which proves the harness
  leaves no file in its temporary directory, no browser process and no open
  Worker port after a failed or interrupted check; and
- each whole-path check with `--reuse-build`.

Add a new whole-path check to the `verify:whole-path` script in the root
`package.json`. Like `verify:worker`, it expects the current source to be
built already.
