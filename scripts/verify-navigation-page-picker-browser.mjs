/**
 * Live acceptance for the navigation page picker (issue #155).
 *
 * Runs the real dashboard, opens the page editor, and drives the picker a
 * navigation link now offers: "A page," "A section on a page," "The Blog,"
 * or "An email address," instead of a free-text path. Confirms the choice
 * saves through the normal content-revision route, then screenshots the
 * picker at 1440px and 390px so the owner's design rules can be checked by
 * eye, not only by markup.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { chromium } from "playwright";

const repositoryRoot = resolve(import.meta.dirname, "..");
const screenshotDir = resolve(repositoryRoot, ".shots/verify-navigation-page-picker");

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("navigation_picker_port_unavailable"));
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
        `navigation_picker_server_exited:${child.exitCode}\n${logs.join("")}`,
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
  throw new Error(`navigation_picker_server_timeout\n${logs.join("")}`);
}

function stopServer(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

/** Opens the Navigation card if it is not open already; safe on desktop or phone. */
async function openNavigationCard(page) {
  const toggle = page.locator(".editor-group-toggle", { hasText: "Navigation" });
  if ((await toggle.count()) === 0) return;
  const expanded = await toggle.first().getAttribute("aria-expanded");
  if (expanded !== "true") await toggle.first().click();
}

async function main() {
  await mkdir(screenshotDir, { recursive: true });
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

    for (const viewport of [
      { width: 1440, height: 900, name: "1440" },
      { width: 390, height: 844, name: "390" },
    ]) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();

      // The dashboard creates the draft workspace on the server, so Overview
      // links straight into the page editor.
      await page.goto(`${origin}/dash`);
      await page
        .getByRole("link", { name: /^(Start|Continue) editing$/u })
        .click();
      await page.waitForURL(/\/dash\/pages\?workspace=workspace_[a-f0-9]{24}$/u);

      // Pages opens on the list of every page. Open the home page from it to
      // reach the editor.
      await page.locator(".pages-list-row").first().click();
      await page.waitForURL(
        /\/dash\/pages\?workspace=workspace_[a-f0-9]{24}&page=/u,
      );

      if (viewport.name === "390") {
        await page.locator(".editor-mobile-menu").click();
      }
      await page.getByRole("button", { name: "Edit", exact: true }).click();

      if (viewport.name === "390") {
        await page.locator(".editor-mobile-menu").click();
        await page.locator(".editor-menu-page-options").click();
      }

      await openNavigationCard(page);
      const hrefField = page
        .locator('[data-field-path="nav_work.href"] .site-href-field')
        .first();
      await hrefField.waitFor({ state: "visible" });

      // Every control the owner taps must be at least 44px high on a phone.
      const controlHeights = await hrefField
        .locator("select, input")
        .evaluateAll((elements) =>
          elements.map((element) => element.getBoundingClientRect().height),
        );
      if (viewport.name === "390" && controlHeights.some((height) => height < 44)) {
        throw new Error(
          `navigation_picker_control_too_short:${JSON.stringify(controlHeights)}`,
        );
      }

      await hrefField.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: resolve(screenshotDir, `picker-${viewport.name}-before.png`),
        fullPage: false,
      });

      // Choose "The Blog" and confirm the save carries the new target.
      const targetSelect = hrefField.locator("select").first();
      const saved = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/foundry-cms/revisions" &&
          response.status() === 201,
      );
      await targetSelect.selectOption("blog");
      const savedResponse = await saved;
      const savedBody = await savedResponse.json();
      const savedNav = (savedBody.definition?.site?.navigation ?? []).find(
        (item) => item.id === "nav_work",
      );
      if (savedNav?.href !== "blog") {
        throw new Error(
          `navigation_picker_blog_href_not_saved:${JSON.stringify(savedNav)}`,
        );
      }

      // A successful edit rebuilds the page editor from the saved
      // definition, which on a phone re-collapses every field group. Reopen
      // Navigation before the next interaction.
      await openNavigationCard(page);
      await hrefField.waitFor({ state: "visible" });

      await hrefField.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: resolve(screenshotDir, `picker-${viewport.name}-after-blog.png`),
        fullPage: false,
      });

      // Switch to "An email address": the field appears with nothing typed
      // yet. A blank address is not a valid mailto: link, so this choice
      // alone saves nothing; the save below waits for a real address.
      await targetSelect.selectOption("email");
      await openNavigationCard(page);
      const emailInput = hrefField.locator('input[type="email"]');
      await emailInput.waitFor({ state: "visible" });
      const savedMailto = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/foundry-cms/revisions" &&
          response.status() === 201,
      );
      await emailInput.fill("owner@example.com");
      const savedMailtoResponse = await savedMailto;
      const savedMailtoBody = await savedMailtoResponse.json();
      const savedMailtoNav = (savedMailtoBody.definition?.site?.navigation ?? []).find(
        (item) => item.id === "nav_work",
      );
      if (savedMailtoNav?.href !== "mailto:owner@example.com") {
        throw new Error(
          `navigation_picker_email_href_not_saved:${JSON.stringify(savedMailtoNav)}`,
        );
      }

      await openNavigationCard(page);
      await hrefField.waitFor({ state: "visible" });

      await hrefField.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: resolve(screenshotDir, `picker-${viewport.name}-after-email.png`),
        fullPage: false,
      });

      await context.close();
    }

    process.stdout.write(
      `Navigation page picker browser acceptance passed at ${origin}: opened the ` +
        `Navigation card, chose "The Blog" and confirmed nav_work.href saved as ` +
        `"blog", then chose "An email address" and confirmed it saved as ` +
        `"mailto:owner@example.com", at 1440px and 390px. Screenshots: ` +
        `${screenshotDir}\n`,
    );
  } finally {
    await browser?.close();
    stopServer(server);
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
