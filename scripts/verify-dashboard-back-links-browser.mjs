// #227 acceptance: every dashboard sub-screen (a route reached from another
// screen, not from the sidebar) shows the shared `DashboardBackLink` above
// its heading, and the link actually returns to the parent screen it names.
//
// This walks the sub-screens a real owner can reach by clicking through the
// dashboard, with no seeded data: the page editor, the campaign writing
// screens, and Connect an agent. Two sub-screens are not walked here because
// nothing in this installation can put data behind them without a seed
// script this repository does not have:
//   - `/dash/forms/<receiptId>` needs a real public form submission, and the
//     public contact form block does not exist yet (#235, #236 are open).
//   - `/dash/review/<previewId>` needs a real MCP preview, which only a
//     connected agent can prepare.
// Both keep their back link covered at the render level instead — see
// `app/dash/forms/[receiptId]/page.test.tsx` and
// `app/dash/review/[previewId]/page.test.tsx`.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

import { chromium } from "playwright";

const repositoryRoot = resolve(import.meta.dirname, "..");

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("dashboard_back_links_port_unavailable"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(port);
      });
    });
  });
}

async function waitForDashboard(origin, child, logs) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `dashboard_back_links_server_exited:${child.exitCode}\n${logs.join("")}`,
      );
    }
    try {
      const response = await fetch(`${origin}/dash`, { redirect: "manual" });
      if (response.status === 200) return;
    } catch {
      // Next has not bound the port yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`dashboard_back_links_server_timeout\n${logs.join("")}`);
}

function stopServer(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

/**
 * Asserts the current screen shows a back link (`.dash-back-link`, the shared
 * component's own class) with the expected words, and that following it lands
 * on the parent address given.
 */
async function checkBackLink(page, { screen, expectedText, expectedPath }) {
  const link = page.locator(".dash-back-link").first();
  await link.waitFor({ state: "visible", timeout: 10_000 });
  const text = (await link.textContent())?.trim() ?? "";
  if (!text.includes(expectedText)) {
    throw new Error(
      `dashboard_back_links_wrong_words:${screen}:got "${text}", wanted it to include "${expectedText}"`,
    );
  }
  await link.click();
  await page.waitForURL(
    (url) => url.pathname === expectedPath,
    { timeout: 10_000 },
  );
}

async function checkPagesEditor(page, origin, viewportLabel) {
  await page.goto(`${origin}/dash/pages`, { waitUntil: "networkidle" });
  const firstPage = page.locator(".dash-row-link").first();
  await firstPage.waitFor({ timeout: 10_000 });
  await firstPage.click();
  await page.waitForURL(/&page=/u, { timeout: 10_000 });
  // The editor's own top bar is a phone-only slide-down sheet, opened by the
  // floating Menu button; on a wide screen it is already the visible top bar.
  if (viewportLabel === "phone") {
    await page.locator(".editor-mobile-menu").click({ timeout: 10_000 });
    await page.waitForTimeout(300);
  }
  await checkBackLink(page, {
    screen: "Pages editor",
    expectedText: "Dashboard",
    expectedPath: "/dash",
  });
}

async function checkNewCampaign(page, origin) {
  await page.goto(`${origin}/dash/campaigns`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "New email" }).click({ timeout: 10_000 });
  await page.waitForURL(/\/dash\/campaigns\/new/u, { timeout: 10_000 });
  await checkBackLink(page, {
    screen: "New email",
    expectedText: "Back to Newsletter",
    expectedPath: "/dash/campaigns",
  });
}

/** Writes one email so a saved campaign screen exists to walk back from. */
async function writeAndOpenCampaign(page, origin) {
  await page.goto(`${origin}/dash/campaigns/new`, { waitUntil: "networkidle" });
  const composer = page.locator("form.composer");
  await composer.waitFor({ state: "visible", timeout: 10_000 });
  await composer.locator('input[name="subject"]').fill("Back link check");
  await composer
    .locator('textarea[name="previewText"]')
    .fill("Checking the way back from a saved email.");
  await composer.locator('input[name="callToActionLabel"]').fill("Read more");
  await composer
    .locator('input[name="callToActionHref"]')
    .fill("https://example.com/read");
  await composer
    .locator(".rich-text-editor [contenteditable]")
    .fill("This email exists only so this check has a saved draft to open.");
  await page.getByRole("button", { name: "Save email" }).click({ timeout: 10_000 });
  await page.waitForURL(/\/dash\/campaigns(\?|$)/u, { timeout: 20_000 });

  const row = page.locator(".dash-row").first();
  await row.waitFor({ timeout: 10_000 });
  await row.locator("a.dash-row-link").click();
  await page.waitForURL(/\/dash\/campaigns\/[^/]+/u, { timeout: 10_000 });
  await checkBackLink(page, {
    screen: "Saved email",
    expectedText: "Back to Newsletter",
    expectedPath: "/dash/campaigns",
  });
}

async function checkConnectAnAgent(page, origin) {
  await page.goto(`${origin}/dash/settings/agents`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("link", { name: "Connect an agent" }).click({
    timeout: 10_000,
  });
  await page.waitForURL(/\/dash\/settings\/connect-agent/u, {
    timeout: 10_000,
  });
  await checkBackLink(page, {
    screen: "Connect an agent",
    expectedText: "Back to Connected agents",
    expectedPath: "/dash/settings/agents",
  });

  // The screen is opened to finish one task, so it also ends with Done, and
  // Done lands on the same tab the back link names.
  await page.goto(`${origin}/dash/settings/connect-agent`, {
    waitUntil: "networkidle",
  });
  const done = page.getByRole("link", { name: "Done" });
  await done.waitFor({ state: "visible", timeout: 10_000 });
  // The Next dev server draws its own floating badge in the bottom corner,
  // which is where Done sits on a phone. The badge is not part of the
  // product, so take it out of the way before clicking.
  await page.evaluate(() => document.querySelector("nextjs-portal")?.remove());
  const doneBox = await done.boundingBox();
  if (doneBox === null || doneBox.height < 44) {
    throw new Error(
      `dashboard_back_links_done_too_short:${doneBox?.height ?? "none"}`,
    );
  }
  await done.click();
  await page.waitForURL((url) => url.pathname === "/dash/settings/agents", {
    timeout: 10_000,
  });
}

async function main() {
  const port = await availablePort();
  if (port === 3000) throw new Error("dashboard_back_links_origin_not_distinct");
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

    for (const [viewportLabel, viewport] of [
      ["desktop", { width: 1440, height: 900 }],
      ["phone", { width: 390, height: 844 }],
    ]) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      // The dashboard creates the draft workspace on the server, so Pages
      // renders its real editing surface as soon as Overview is open.
      await page.goto(`${origin}/dash`, { waitUntil: "networkidle" });
      await page
        .getByRole("link", { name: /^(Start|Continue) editing$/u })
        .waitFor({ state: "visible" });

      try {
        await checkPagesEditor(page, origin, viewportLabel);
        await checkNewCampaign(page, origin);
        await writeAndOpenCampaign(page, origin);
        await checkConnectAnAgent(page, origin);
      } catch (error) {
        throw new Error(
          `dashboard_back_links_failed:${viewportLabel}:${error instanceof Error ? error.message : String(error)}`,
        );
      }

      await context.close();
    }

    process.stdout.write(
      `Dashboard back-link acceptance passed at ${origin} (1440px and 390px): the page editor, New email, a saved email, and Connect an agent each show the shared back link and it returns to the named parent; Connect an agent also ends with Done, which returns to Connected agents.\n`,
    );
  } finally {
    await browser?.close();
    stopServer(server);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
