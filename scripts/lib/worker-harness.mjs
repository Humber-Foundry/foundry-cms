import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { chromium } from "playwright";
import { unstable_startWorker } from "wrangler";

/**
 * Whole-path browser checks against the built Worker.
 *
 * The harness builds the Worker, serves it locally with the bindings in
 * `apps/reference-site/wrangler.jsonc`, and backs them with a fresh local D1
 * database (every migration applied) and local R2. A check gets an origin, a
 * visitor page and a signed-in page, and everything is stopped and removed
 * afterwards. `docs/operations/whole-path-browser-checks.md` explains how to
 * write a check; ADR-0050 records why the sign-in is safe.
 *
 * Importing this module adds a process `exit` hook that stops any command
 * still running from `run`.
 */

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
export const siteRoot = join(repositoryRoot, "apps", "reference-site");
const wranglerConfig = join(siteRoot, "wrangler.jsonc");
const databaseName = "foundry-reference-site";
const siteId = "site_foundry_reference";

const turnstileSiteverifyUrl =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
// Cloudflare's published test pair that always passes. The site key makes the
// real widget hand out the dummy token, and only the test secret accepts it:
// https://developers.cloudflare.com/turnstile/troubleshooting/testing/
const turnstileTestSiteKey = "1x00000000000000000000AA";
const turnstileTestSecret = "1x0000000000000000000000000000000AA";

/**
 * The three path families ADR-0005 puts behind Cloudflare Access. A signed-in
 * page sends the Access assertion on these and nowhere else, as Access does.
 */
function isAccessProtectedPath(pathname) {
  return ["/dash", "/api/foundry-cms", "/__foundry/preview"].some(
    (base) => pathname === base || pathname.startsWith(`${base}/`),
  );
}

// Commands started by `run` that are still running. If the process exits early,
// they are stopped first, so none of them writes into a directory after it
// is removed. This hook is added before any directory hook, so it runs first.
const runningChildren = new Set();
process.on("exit", () => {
  for (const child of runningChildren) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // It has already exited.
    }
  }
});

/** Run a command to the end, and throw with its output if it fails. */
export async function run(command, args, options) {
  const output = [];
  const child = spawn(command, args, {
    ...options,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  runningChildren.add(child);
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  const code = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  }).finally(() => runningChildren.delete(child));
  if (code !== 0) {
    throw new Error(
      `worker_harness_command_failed:${command} ${args.join(" ")}:${code}\n` +
        output.join(""),
    );
  }
}

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === "string") {
          reject(new Error("worker_harness_port_unavailable"));
        } else {
          resolvePort(address.port);
        }
      });
    });
  });
}

/**
 * The harness's stand-in for Cloudflare Access: an Access team with one
 * member, made for this run only.
 *
 * The team name, the audience and the signing key are random for each run.
 * The private key is never written anywhere and never leaves this process.
 * The Worker accepts an assertion signed with it only because the harness
 * answers the Worker's request for the team's public keys. A deployed Worker
 * sends that request to Cloudflare, which has never seen this key, so it
 * refuses the assertion. No Worker code knows about the harness.
 */
export async function createAccessStandIn() {
  const team = `foundry-harness-${randomBytes(8).toString("hex")}`;
  const issuer = `https://${team}.cloudflareaccess.com`;
  const audience = randomBytes(32).toString("hex");
  const keyId = randomUUID();
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const member = Object.freeze({
    subject: randomUUID(),
    email: "owner@harness.example",
  });

  return Object.freeze({
    issuer,
    audience,
    member,
    keySetUrl: `${issuer}/cdn-cgi/access/certs`,
    keySet: Object.freeze({
      keys: [
        {
          ...(await exportJWK(publicKey)),
          kid: keyId,
          alg: "RS256",
          use: "sig",
        },
      ],
    }),
    /** A fresh Access application token for the member, valid for an hour. */
    async assertion() {
      const now = Math.floor(Date.now() / 1_000);
      return new SignJWT({
        type: "app",
        email: member.email,
        identity_nonce: randomUUID(),
      })
        .setProtectedHeader({ alg: "RS256", kid: keyId })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject(member.subject)
        .setIssuedAt(now)
        .setNotBefore(now)
        .setExpirationTime(now + 60 * 60)
        .sign(privateKey);
    },
  });
}

function sqlText(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

/** The stand-in's member as an active Owner of the reference site. */
function ownerMembershipSql({ issuer, member }) {
  const now = sqlText(new Date().toISOString());
  const userId = sqlText("user-harness-owner");
  const email = sqlText(member.email);
  const subject = sqlText(member.subject);
  return `
INSERT INTO human_users (id, email, created_at)
  VALUES (${userId}, ${email}, ${now});
INSERT INTO human_external_identities (site_id, issuer, subject, user_id, created_at)
  VALUES (${sqlText(siteId)}, ${sqlText(issuer)}, ${subject}, ${userId}, ${now});
INSERT INTO human_memberships (
  id, site_id, user_id, email, identity_issuer, identity_subject,
  role, status, created_at, updated_at
) VALUES (
  'membership-harness-owner', ${sqlText(siteId)}, ${userId}, ${email},
  ${sqlText(issuer)}, ${subject}, 'owner', 'active', ${now}, ${now}
);
`;
}

/**
 * A fresh local database with every migration applied and the stand-in's
 * member added, in a new directory under the system temporary directory.
 * The caller calls `remove()` when it is done.
 *
 * Wrangler stops its runtime and exits on an interrupt before an
 * asynchronous clean-up can finish, so the directory is also removed
 * synchronously when the process exits.
 */
export async function prepareLocalState(accessStandIn) {
  const directory = await mkdtemp(join(tmpdir(), "foundry-worker-harness-"));
  const removeOnExit = () => rmSync(directory, { recursive: true, force: true });
  process.once("exit", removeOnExit);
  const remove = async () => {
    process.off("exit", removeOnExit);
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const persistTo = join(directory, "state");
    const wranglerD1 = (args) =>
      run(
        "npx",
        ["wrangler", "d1", ...args, "--local", "--persist-to", persistTo],
        { cwd: siteRoot, env: { ...process.env, CI: "1" } },
      );
    await wranglerD1(["migrations", "apply", databaseName]);
    const memberFile = join(directory, "member.sql");
    await writeFile(memberFile, ownerMembershipSql(accessStandIn));
    await wranglerD1(["execute", databaseName, "--file", memberFile]);
    return { persistTo, remove };
  } catch (error) {
    await remove();
    throw error;
  }
}

/**
 * Every setting the Worker reads that `wrangler.jsonc` leaves to a secret or
 * to guided provisioning. Each secret is random for this run.
 */
function workerSettings({ origin, accessStandIn }) {
  const plainText = (value) => ({ type: "plain_text", value });
  const secretText = (value) => ({ type: "secret_text", value });
  const randomSecret = () => secretText(randomBytes(32).toString("hex"));
  return {
    FOUNDRY_CANONICAL_ORIGIN: plainText(origin),
    FOUNDRY_ACCESS_ISSUER: plainText(accessStandIn.issuer),
    FOUNDRY_ACCESS_AUDIENCE: plainText(accessStandIn.audience),
    FOUNDRY_TURNSTILE_SITE_KEY: plainText(turnstileTestSiteKey),
    FOUNDRY_TURNSTILE_SECRET: secretText(turnstileTestSecret),
    FOUNDRY_CSRF_SECRET: randomSecret(),
    FOUNDRY_SUBSCRIBER_IDENTITY_SECRET: randomSecret(),
    FOUNDRY_NEWSLETTER_DELIVERY_SECRET: randomSecret(),
  };
}

/**
 * Serve the built Worker on `https://127.0.0.1:<port>` with the bindings in
 * `wrangler.jsonc` and this run's settings.
 *
 * `outbound(request, origin)` answers every request the Worker sends out.
 * Leave it undefined to let those requests reach the network, as a deployed
 * Worker's do.
 */
export async function startBuiltWorker({ persistTo, accessStandIn, outbound }) {
  const port = await availablePort();
  const origin = `https://127.0.0.1:${port}`;
  const worker = await unstable_startWorker({
    config: wranglerConfig,
    envFiles: [],
    bindings: workerSettings({ origin, accessStandIn }),
    dev: {
      persist: persistTo,
      server: { hostname: "127.0.0.1", port, secure: true },
      inspector: false,
      watch: false,
      logLevel: "warn",
      ...(outbound === undefined
        ? {}
        : { outboundService: (request) => outbound(request, origin) }),
    },
  });
  try {
    await worker.ready;
  } catch (error) {
    await worker.dispose();
    throw error;
  }
  return { origin, worker };
}

/**
 * Siteverify, run for real against Cloudflare with the test secret.
 *
 * Cloudflare's test answer always names `example.com` and carries no action
 * (see the testing page above), while the Worker refuses an answer whose
 * hostname and action are not its own (ADR-0001). So when Cloudflare reports
 * success, the harness fills in those two fields with the values a real widget
 * on this site would produce. Cloudflare's verdict still decides.
 */
async function siteverifyWithTestSecret(request, { hostname, action }) {
  const response = await fetch(turnstileSiteverifyUrl, {
    method: "POST",
    headers: { "content-type": request.headers.get("content-type") ?? "" },
    body: await request.text(),
    signal: AbortSignal.timeout(10_000),
  });
  const answer = await response.json();
  if (answer.success !== true) {
    return Response.json(answer, { status: response.status });
  }
  return Response.json({ ...answer, hostname, action });
}

function harnessOutbound({ accessStandIn, turnstileAction, refused }) {
  return async (request, origin) => {
    if (request.method === "GET" && request.url === accessStandIn.keySetUrl) {
      return Response.json(accessStandIn.keySet);
    }
    if (request.method === "POST" && request.url === turnstileSiteverifyUrl) {
      return siteverifyWithTestSecret(request, {
        hostname: new URL(origin).hostname,
        action: turnstileAction,
      });
    }
    // Nothing else leaves the harness, so a check never reaches a real
    // provider account. The check can read what was refused.
    refused.push(`${request.method} ${request.url}`);
    return new Response("refused by the worker harness", { status: 502 });
  };
}

/**
 * Build and start everything one check needs. Prefer `withWorkerHarness`,
 * which also stops it.
 *
 * - `build`: run `npm run build && npm run build:worker` first. Pass `false`
 *   only when the current source has just been built, as Product CI does.
 * - `turnstileAction`: the action of the form the check sends.
 */
export async function startWorkerHarness({
  build = true,
  turnstileAction,
} = {}) {
  const stops = [];
  // One clean-up, however many callers ask for it: an interrupt and a
  // failing check can both reach it at once.
  let stopped;
  const stop = () => {
    stopped ??= (async () => {
      while (stops.length > 0) {
        try {
          await stops.pop()();
        } catch (error) {
          process.stderr.write(
            `worker harness cleanup failed: ${String(error)}\n`,
          );
        }
      }
    })();
    return stopped;
  };

  try {
    if (build) {
      await run("npm", ["run", "build"], { cwd: repositoryRoot });
      await run("npm", ["run", "build:worker"], { cwd: repositoryRoot });
    }
    const accessStandIn = await createAccessStandIn();
    const state = await prepareLocalState(accessStandIn);
    stops.push(state.remove);

    const refusedOutbound = [];
    const { origin, worker } = await startBuiltWorker({
      persistTo: state.persistTo,
      accessStandIn,
      outbound: harnessOutbound({
        accessStandIn,
        turnstileAction,
        refused: refusedOutbound,
      }),
    });
    stops.push(() => worker.dispose());

    const browser = await chromium.launch({ headless: true });
    stops.push(() => browser.close());

    // The Worker's certificate is Miniflare's own local one, so the browser is
    // told to accept it. The page origin is still `https://127.0.0.1:<port>`,
    // which is the canonical origin the Worker checks.
    const newContext = (viewport) =>
      browser.newContext({ viewport, ignoreHTTPSErrors: true });

    return Object.freeze({
      origin,
      refusedOutbound,
      /** A page with no Access session, as a visitor has. */
      async newVisitorPage({ viewport = { width: 1440, height: 900 } } = {}) {
        return (await newContext(viewport)).newPage();
      },
      /**
       * A page signed in as an active Owner. The assertion is added only to
       * requests for this origin's Access-protected paths.
       */
      async newSignedInPage({ viewport = { width: 1440, height: 900 } } = {}) {
        const context = await newContext(viewport);
        const assertion = await accessStandIn.assertion();
        await context.route(
          (url) =>
            url.origin === origin && isAccessProtectedPath(url.pathname),
          (route) =>
            route.continue({
              headers: {
                ...route.request().headers(),
                // `cloudflareAccessAssertionHeader` in
                // apps/reference-site/src/access-authentication.ts
                "cf-access-jwt-assertion": assertion,
              },
            }),
        );
        return context.newPage();
      },
      stop,
    });
  } catch (error) {
    await stop();
    throw error;
  }
}

/** The exit code for a process stopped by `signal`: 128 plus its number. */
export function interruptedExitCode(signal) {
  return signal === "SIGINT" ? 130 : 143;
}

/**
 * Start the harness, run `check` with it, and stop everything afterwards,
 * whether the check passes, fails or the process is interrupted.
 */
export async function withWorkerHarness(options, check) {
  let harness;
  const interrupted = (signal) => {
    void Promise.resolve(harness?.stop()).finally(() =>
      process.exit(interruptedExitCode(signal)),
    );
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    harness = await startWorkerHarness(options);
    return await check(harness);
  } finally {
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
    await harness?.stop();
  }
}
