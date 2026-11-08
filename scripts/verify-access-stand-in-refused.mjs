import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { confirmCloudflareRefusesTeam } from "./lib/cloudflare-team-refusal.mjs";
import {
  createAccessStandIn,
  interruptedExitCode,
  prepareLocalState,
  run,
  siteRoot,
  startBuiltWorker,
} from "./lib/worker-harness.mjs";

/**
 * Proves that a deployed build refuses the worker harness's Access stand-in
 * (ADR-0050). Run it after `npm run build && npm run build:worker`.
 *
 * 1. The deploy bundle, made by `wrangler deploy --dry-run`, holds no harness
 *    code.
 * 2. Control: the built Worker accepts the stand-in's assertion when the
 *    harness answers the request for the Access team's keys. Without this
 *    the refusals below could have another cause.
 * 3. The same build, with the same settings and the stand-in's member in its
 *    database, refuses the same assertion when the key request goes out to
 *    the network, as it does from a deployed Worker. First this script sends
 *    the same key request itself and requires Cloudflare's 404 for a team
 *    that does not exist. If that request gets no answer, the run has no
 *    network, and the check fails and says so.
 * 4. It also refuses it when the team's keys are keys the harness does not
 *    hold, which is what Cloudflare serves for a real team.
 */

// Words that appear in the harness and nowhere in the product.
const harnessMarkers = ["foundry-harness-", "worker-harness"];

async function deployBundleText() {
  const directory = await mkdtemp(join(tmpdir(), "foundry-deploy-bundle-"));
  try {
    await run("npx", ["wrangler", "deploy", "--dry-run", "--outdir", directory], {
      cwd: siteRoot,
      env: { ...process.env, CI: "1" },
    });
    const files = (await readdir(directory)).filter((name) =>
      name.endsWith(".js"),
    );
    if (files.length === 0) {
      throw new Error("deploy_dry_run_wrote_no_bundle");
    }
    return (
      await Promise.all(files.map((name) => readFile(join(directory, name), "utf8")))
    ).join("\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function messagesStatus({ persistTo, accessStandIn, outbound }) {
  const { worker, origin } = await startBuiltWorker({
    persistTo,
    accessStandIn,
    outbound,
  });
  try {
    const response = await worker.fetch(`${origin}/dash/forms`, {
      // `cloudflareAccessAssertionHeader` in
      // apps/reference-site/src/access-authentication.ts
      headers: { "cf-access-jwt-assertion": await accessStandIn.assertion() },
      redirect: "manual",
    });
    const body = await response.text();
    return {
      status: response.status,
      showsMessages: body.includes("Forms on your site"),
    };
  } finally {
    await worker.dispose();
  }
}

/** Answer the Access team's key request with `keySet`; refuse the rest. */
function answerTeamKeys(accessStandIn, keySet) {
  return async (request) =>
    request.url === accessStandIn.keySetUrl
      ? Response.json(keySet)
      : new Response("refused", { status: 502 });
}

async function main() {
  const bundle = await deployBundleText();
  for (const marker of harnessMarkers) {
    if (bundle.includes(marker)) {
      throw new Error(`deploy_bundle_carries_harness_code:${marker}`);
    }
  }

  const accessStandIn = await createAccessStandIn();
  const keysTheHarnessDoesNotHold = (await createAccessStandIn()).keySet;
  const state = await prepareLocalState(accessStandIn);
  try {
    const accepted = await messagesStatus({
      persistTo: state.persistTo,
      accessStandIn,
      outbound: answerTeamKeys(accessStandIn, accessStandIn.keySet),
    });
    if (accepted.status !== 200 || !accepted.showsMessages) {
      throw new Error(`control_not_accepted:${accepted.status}`);
    }

    await confirmCloudflareRefusesTeam(accessStandIn.keySetUrl);
    const deployed = await messagesStatus({
      persistTo: state.persistTo,
      accessStandIn,
      outbound: undefined,
    });
    // The Worker could not get the team's keys, so no identity could be
    // verified.
    if (deployed.status !== 503 || deployed.showsMessages) {
      throw new Error(`deployed_build_accepted_stand_in:${deployed.status}`);
    }

    const otherKeys = await messagesStatus({
      persistTo: state.persistTo,
      accessStandIn,
      outbound: answerTeamKeys(accessStandIn, keysTheHarnessDoesNotHold),
    });
    if (otherKeys.status !== 404 || otherKeys.showsMessages) {
      throw new Error(`other_keys_accepted_stand_in:${otherKeys.status}`);
    }

    process.stdout.write(
      "Access stand-in refused by the deploy build: " +
        `no harness code in the bundle; control ${accepted.status}, ` +
        `deployed network ${deployed.status} (this script's own key request ` +
        `got Cloudflare's 404), other keys ${otherKeys.status}.\n`,
    );
  } finally {
    await state.remove();
  }
}

// An interrupt exits through `process.exit`, so the harness's exit hooks stop
// its commands and remove the database directory.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => process.exit(interruptedExitCode(signal)));
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error?.stack ?? String(error)}\n`);
  process.exitCode = 1;
}
