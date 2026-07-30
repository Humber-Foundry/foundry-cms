import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

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
    "@foundry/reference-site",
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
    "Verified the public page, fail-closed dashboard, and bearer-guarded " +
      "public integration callback in workerd.",
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
