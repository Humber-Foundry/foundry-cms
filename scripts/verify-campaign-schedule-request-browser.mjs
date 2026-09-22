/**
 * Live acceptance and screenshots for issue #172 slice two: an app's send-time request on the
 * Newsletter screen, and the same request on Overview's "Needs attention"
 * list, at 1440px and at 390px.
 *
 * It runs the real dashboard and writes a real campaign through the composer.
 * A request itself is written by `foundry.campaign.schedule_request`, which
 * needs an authorized MCP connection, so this supplies the pending request by
 * answering the screens' own read with one: the Newsletter list read
 * (`GET /api/foundry-cms/campaigns`) and the Overview page's own request
 * lookup. Everything drawn is the real component and the real stylesheet.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { chromium } from "playwright";

const repositoryRoot = resolve(import.meta.dirname, "..");
const outputDirectory = resolve(repositoryRoot, ".shots");

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function waitForDashboard(origin, child, logs) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server_exited:${child.exitCode}\n${logs.join("")}`);
    }
    try {
      const response = await fetch(`${origin}/dash`, { redirect: "manual" });
      if (response.status === 200) return;
    } catch {
      // Next has not bound the port yet.
    }
    await new Promise((wait) => setTimeout(wait, 250));
  }
  throw new Error(`server_timeout\n${logs.join("")}`);
}

function stopServer(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

const scheduleRequest = {
  proposalId: "schedule_request_1",
  agentName: "client.example",
  localDateTime: "2026-09-24T09:30:00",
  ianaTimeZone: "America/Vancouver",
};

async function main() {
  await mkdir(outputDirectory, { recursive: true });
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const logs = [];
  const server = spawn(
    "npm",
    [
      "run",
      "dev",
      "--workspace",
      "@humber-foundry/reference-site",
      "--",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: repositoryRoot,
      detached: true,
      env: {
        ...process.env,
        FOUNDRY_PRIVATE_PREVIEW_ORIGIN: origin,
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const capture = (chunk) => {
    logs.push(String(chunk));
    while (logs.join("").length > 20_000) logs.shift();
  };
  server.stdout.on("data", capture);
  server.stderr.on("data", capture);

  let browser;
  try {
    await waitForDashboard(origin, server, logs);
    browser = await chromium.launch({ headless: true });

    for (const [label, width] of [
      ["1440", 1440],
      ["390", 390],
    ]) {
      const context = await browser.newContext({
        viewport: { width, height: 1400 },
      });
      const page = await context.newPage();

      // The Newsletter list read answers with the campaign the composer saves
      // and the one request waiting for a person.
      let campaignId = null;
      await page.route(
        (url) =>
          url.pathname === "/api/foundry-cms/campaigns" && url.search === "",
        async (route) => {
          if (route.request().method() !== "GET") {
            await route.fallback();
            return;
          }
          const response = await route.fetch();
          const body = await response.json();
          campaignId = body.campaigns?.[0]?.campaign?.id ?? null;
          await route.fulfill({
            response,
            json: {
              ...body,
              scheduleRequests:
                campaignId === null
                  ? []
                  : [{ ...scheduleRequest, campaignId }],
            },
          });
        },
      );

      await page.goto(`${origin}/dash`);
      // Overview's site card opens the page editor on the home page (#228).
      await page.getByRole("link", { name: "Edit site" }).click();
      await page.waitForURL(
        /\/dash\/pages\?workspace=workspace_[a-f0-9]{24}&page=/u,
      );
      const workspace = new URL(page.url()).searchParams.get("workspace");

      await page.goto(`${origin}/dash/campaigns?workspace=${workspace}`);
      await page.getByRole("heading", { name: "Newsletter" }).waitFor();
      // Newsletter opens on the campaign list (#237), so the writing box is
      // reached through "New email".
      await page.getByRole("button", { name: "New email" }).click();
      await page.waitForURL(/\/dash\/campaigns\/new\?workspace=workspace_/u);
      const composer = page.locator("form.composer");
      await composer.waitFor({ state: "visible" });
      await composer
        .locator('input[name="subject"]')
        .fill("Harbour dispatch — September");
      await composer
        .locator('textarea[name="previewText"]')
        .fill("What changed at the harbour this month.");
      await composer.locator('input[name="callToActionLabel"]').fill("Read more");
      await composer
        .locator('input[name="callToActionHref"]')
        .fill("https://example.com/read");
      await composer.locator(".rich-text-editor [contenteditable]").fill(
        "The new pontoon is finished and the winter berths are open.",
      );
      await page.getByRole("button", { name: "Save email" }).click();

      // The save returns to the list, and the list read above supplies the
      // request, so the campaign row now shows what the app asked for.
      await page.waitForURL(/\/dash\/campaigns\?workspace=workspace_/u);
      await page
        .getByText(/asked to send this at/u)
        .waitFor({ state: "visible" });
      await page.screenshot({
        path: `${outputDirectory}/campaigns-schedule-request-${label}.png`,
        fullPage: true,
      });

      // Declining is a person's step, and it reaches the real route with the
      // request it names.
      const declined = page.waitForRequest(
        (request) =>
          request.method() === "POST" &&
          new URL(request.url()).pathname === "/api/foundry-cms/campaigns" &&
          JSON.parse(request.postData() ?? "{}").action ===
            "decline_schedule_request",
      );
      // A row's actions sit behind its "..." menu since #226.
      await page
        .getByRole("button", { name: /^Actions for / })
        .first()
        .click();
      await page
        .getByRole("menuitem", { name: "Decline the app's send request" })
        .click();
      const command = JSON.parse((await declined).postData() ?? "{}");
      if (command.proposalId !== scheduleRequest.proposalId) {
        throw new Error("decline_named_the_wrong_request");
      }

      // Overview, for the "Needs attention" list this change also writes to.
      // Local development holds no request, so this shows the list as it
      // stands rather than the new row; the row itself is covered by
      // attention-list.browser.test.tsx.
      await page.goto(`${origin}/dash`);
      await page.getByRole("heading", { name: "Needs attention" }).waitFor();
      await page.screenshot({
        path: `${outputDirectory}/overview-${label}.png`,
        fullPage: true,
      });

      await context.close();
    }
  } finally {
    if (browser !== undefined) await browser.close();
    stopServer(server);
  }
  console.log(`screenshots written to ${outputDirectory}`);
}

await main();
