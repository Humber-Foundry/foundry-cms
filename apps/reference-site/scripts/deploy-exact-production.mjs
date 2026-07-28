#!/usr/bin/env node

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { assertExactProductionHead } from "./assert-exact-production-head.mjs";

export async function deployExactProduction({
  assertHead = assertExactProductionHead,
  startDeployment = () =>
    spawn("opennextjs-cloudflare", ["deploy"], {
      stdio: "inherit",
      shell: false,
    }),
  pollIntervalMs = 250,
} = {}) {
  assertHead();
  const deployment = startDeployment();
  await new Promise((resolve, reject) => {
    let fenceError;
    const verifyFence = () => {
      try {
        assertHead();
      } catch (error) {
        fenceError = error;
        deployment.kill("SIGTERM");
      }
    };
    const poll = setInterval(verifyFence, pollIntervalMs);
    verifyFence();
    deployment.once("error", (error) => {
      clearInterval(poll);
      reject(error);
    });
    deployment.once("exit", (code, signal) => {
      clearInterval(poll);
      if (fenceError !== undefined) {
        reject(fenceError);
        return;
      }
      try {
        assertHead();
      } catch (error) {
        reject(error);
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `exact_deployment_failed:${code ?? "signal"}:${signal ?? "none"}`,
          ),
        );
        return;
      }
      resolve();
    });
  });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  deployExactProduction()
    .then(() => {
      console.log("Exact production deployment completed.");
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
