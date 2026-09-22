import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { contentSecurityPolicyDirectives } from "./lib/content-security-policy.mjs";
import { assertReferencePage } from "./lib/reference-page.mjs";

async function findAvailablePort() {
  const server = createServer();

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (typeof address === "string" || address === null) {
        server.close();
        reject(new Error("Could not determine an available local port."));
        return;
      }

      server.close(() => resolve(address.port));
    });
  });
}

async function waitForWorker(origin, process) {
  const deadline = Date.now() + 45_000;

  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(
        `The Cloudflare preview exited before it became ready (code ${process.exitCode}).`,
      );
    }

    try {
      const response = await fetch(origin);
      if (response.ok) {
        return response;
      }
    } catch {
      // Wrangler is still starting.
    }

    await delay(250);
  }

  throw new Error("Timed out waiting for the Cloudflare Workers preview.");
}

const port = await findAvailablePort();
const origin = `http://127.0.0.1:${port}`;
const preview = spawn(
  "npm",
  [
    "run",
    "preview:serve",
    "--workspace",
    "@humber-foundry/reference-site",
    "--",
    "--port",
    String(port),
    "--ip",
    "127.0.0.1",
  ],
  {
    detached: true,
    env: {
      ...process.env,
      CI: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let previewOutput = "";
preview.stdout.on("data", (chunk) => {
  previewOutput += chunk;
});
preview.stderr.on("data", (chunk) => {
  previewOutput += chunk;
});

function stopPreview(signal) {
  if (preview.pid !== undefined) {
    try {
      process.kill(-preview.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
  }
}

try {
  const publicResponse = await waitForWorker(origin, preview);
  const publicHtml = await publicResponse.text();

  assertReferencePage(publicHtml);

  const dashboardResponse = await fetch(`${origin}/dash`, {
    redirect: "manual",
  });

  if (dashboardResponse.status !== 404) {
    throw new Error(
      `Unconfigured production dashboard returned ${dashboardResponse.status}; expected 404.`,
    );
  }

  // The dashboard's Content Security Policy (#234, ADR-0049) is a
  // `next.config` header. This is the one place the built Worker is served,
  // so this is where it is proven to carry the policy, not only the dev
  // server. `/dash` itself is answered above by the Worker's own identity
  // boundary, before Next runs, so a path below it is the one to check.
  const designResponse = await fetch(`${origin}/dash/design`, {
    redirect: "manual",
  });
  const dashboardPolicy = contentSecurityPolicyDirectives(
    designResponse.headers.get("content-security-policy") ?? "",
  );
  for (const [name, expected] of [
    ["script-src", "'self'"],
    ["frame-src", "'self'"],
    ["object-src", "'none'"],
  ]) {
    if (!(dashboardPolicy.get(name) ?? []).includes(expected)) {
      throw new Error(
        `The Worker served /dash/design without \`${name} ${expected}\` in ` +
          "its Content-Security-Policy header.",
      );
    }
  }
  if ((dashboardPolicy.get("script-src") ?? []).includes("'unsafe-eval'")) {
    throw new Error(
      "The Worker served /dash/design with 'unsafe-eval', which only the " +
        "development server needs.",
    );
  }
  if (publicResponse.headers.get("content-security-policy") !== null) {
    throw new Error(
      "The Worker served the public page with the dashboard's Content-Security-Policy.",
    );
  }

  const integrationCallbackResponse = await fetch(
    `${origin}/api/integrations/brevo/webhooks/transactional`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      redirect: "manual",
    },
  );
  if (integrationCallbackResponse.status !== 401) {
    throw new Error(
      "Unauthenticated Brevo integration callback returned " +
        `${integrationCallbackResponse.status}; expected 401.`,
    );
  }

  console.log(
    "Verified the public page, fail-closed dashboard with its " +
      "Content-Security-Policy, and bearer-guarded public integration " +
      "callback in workerd.",
  );
} catch (error) {
  process.stderr.write(previewOutput);
  throw error;
} finally {
  stopPreview("SIGTERM");
  await Promise.race([
    new Promise((resolve) => preview.once("exit", resolve)),
    delay(5_000),
  ]);

  if (preview.exitCode === null) {
    stopPreview("SIGKILL");
  }
}
