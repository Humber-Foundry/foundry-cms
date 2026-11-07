import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Proves the worker harness leaves nothing behind when a check fails and when
 * a check is interrupted (#259). Run it after `npm run build && npm run
 * build:worker`.
 *
 * Each case runs one harness in a child process with its own temporary
 * directory. The check prints the Worker's origin, then fails or waits to be
 * interrupted. Afterwards the child must have exited by itself, the temporary
 * directory must hold nothing but tool caches, and nothing may answer on the
 * Worker's port. The database and the browser profile both live in that
 * directory, so a leftover of either fails the check.
 */

const harnessUrl = pathToFileURL(
  join(import.meta.dirname, "lib", "worker-harness.mjs"),
).href;

const childCheck = (ending) => `
import { withWorkerHarness } from ${JSON.stringify(harnessUrl)};
await withWorkerHarness({ build: false }, async (harness) => {
  await (await harness.newSignedInPage()).goto(harness.origin + "/");
  process.stdout.write("origin " + harness.origin + "\\n");
  ${ending}
});
`;

// Caches that Node and the Wrangler command line keep in the temporary
// directory on purpose. They hold no harness state.
const toolCaches = new Set(["node-compile-cache", "update-check"]);

const endings = {
  failure: 'throw new Error("check_failed_on_purpose");',
  interrupt: "await new Promise(() => {});",
};

function portAnswers(origin) {
  const { hostname, port } = new URL(origin);
  return new Promise((resolveAnswer) => {
    const socket = connect({ host: hostname, port: Number(port) });
    socket.once("connect", () => {
      socket.destroy();
      resolveAnswer(true);
    });
    socket.once("error", () => resolveAnswer(false));
  });
}

async function runCase(name) {
  const directory = await mkdtemp(join(tmpdir(), "foundry-harness-cleanup-"));
  try {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", childCheck(endings[name])],
      {
        env: { ...process.env, TMPDIR: directory },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const output = [];
    child.stderr.on("data", (chunk) => output.push(String(chunk)));
    const origin = await new Promise((resolveOrigin, reject) => {
      child.stdout.on("data", (chunk) => {
        output.push(String(chunk));
        const match = /origin (\S+)/u.exec(output.join(""));
        if (match !== null) resolveOrigin(match[1]);
      });
      child.once("exit", (code) =>
        reject(new Error(`${name}_exited_before_ready:${code}\n${output.join("")}`)),
      );
    });
    if (name === "interrupt") child.kill("SIGINT");

    const code = await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      new Promise((resolveExit) =>
        setTimeout(() => resolveExit("timeout"), 60_000),
      ),
    ]);
    if (code === "timeout") {
      child.kill("SIGKILL");
      throw new Error(`${name}_child_did_not_exit\n${output.join("")}`);
    }
    if (code === 0) {
      throw new Error(`${name}_child_exited_0\n${output.join("")}`);
    }
    const left = (await readdir(directory)).filter(
      (name) => !toolCaches.has(name),
    );
    if (left.length > 0) {
      throw new Error(`${name}_left_temporary_files:${left.join(",")}`);
    }
    if (await portAnswers(origin)) {
      throw new Error(`${name}_left_port_open:${origin}`);
    }
    return code;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

try {
  const failure = await runCase("failure");
  const interrupt = await runCase("interrupt");
  process.stdout.write(
    "worker harness clean-up: nothing left after a failed check " +
      `(exit ${failure}) or an interrupted check (exit ${interrupt}).\n`,
  );
} catch (error) {
  process.stderr.write(`${error?.stack ?? String(error)}\n`);
  process.exitCode = 1;
}
