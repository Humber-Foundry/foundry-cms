// Phone editor acceptance: on a narrow screen the page fills the screen and
// the editor chrome lives in slide-in sheets.
//
// The docked, desktop workflow is covered by verify-private-dashboard-browser.
// This test drives the phone layout: a floating Menu opens the top controls, a
// floating Page-options button and a tap on a section each open the side panel
// as a bottom sheet, and Done closes it. It asserts the sheets actually move on
// and off screen, not merely that the markup exists.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

import { chromium } from "playwright";

const repositoryRoot = resolve(import.meta.dirname, "..");
const VIEWPORT = { width: 390, height: 844 };

function availablePort() {
  return new Promise((res, rej) => {
    const server = createServer();
    server.unref();
    server.on("error", rej);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => res(port));
    });
  });
}

async function waitForDashboard(origin, deadlineMs = 120_000) {
  const start = Date.now();
  for (;;) {
    try {
      const response = await fetch(`${origin}/dash`, { redirect: "manual" });
      if ([200, 307, 308].includes(response.status)) return;
    } catch {
      // Server not up yet.
    }
    if (Date.now() - start > deadlineMs) throw new Error("mobile_editor_dashboard_timeout");
    await new Promise((r) => setTimeout(r, 700));
  }
}

/** The element's bounding rect, or null when it is not in the document. */
function rectOf(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, height: r.height, width: r.width };
  }, selector);
}

/**
 * Waits for a sheet to settle after its slide transition, then returns the
 * rect. Polls the predicate so the check is not read mid-animation.
 */
async function settledRect(page, selector, predicate, failure, timeoutMs = 4000) {
  const start = Date.now();
  let rect = null;
  for (;;) {
    rect = await rectOf(page, selector);
    if (rect !== null && predicate(rect)) return rect;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`${failure}:${JSON.stringify(rect)}`);
    }
    await page.waitForTimeout(120);
  }
}

const port = await availablePort();
if (port === 3000) throw new Error("mobile_editor_origin_not_distinct");
const origin = `http://127.0.0.1:${port}`;
const logs = [];
const server = spawn(
  "npm",
  ["run", "dev", "--workspace", "@humber-foundry/reference-site", "--",
   "--hostname", "127.0.0.1", "--port", String(port)],
  { cwd: repositoryRoot, detached: true,
    env: { ...process.env, FOUNDRY_PRIVATE_PREVIEW_ORIGIN: origin, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"] },
);
const capture = (chunk) => {
  logs.push(String(chunk));
  while (logs.join("").length > 20_000) logs.shift();
};
server.stdout.on("data", capture);
server.stderr.on("data", capture);

let browser;
try {
  await waitForDashboard(origin);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  await page.goto(`${origin}/dash`);

  const startWorkspace = page.getByRole("button", { name: "Start workspace" });
  await startWorkspace.waitFor({ state: "visible" });
  const [created] = await Promise.all([
    page.waitForResponse((r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname === "/api/foundry-cms/revisions"),
    startWorkspace.click(),
  ]);
  if (created.status() !== 201) {
    throw new Error(`mobile_editor_workspace_failed:${created.status()}`);
  }
  await page.waitForURL(/\/dash\/pages\?workspace=workspace_[a-f0-9]{24}$/u);
  await page.getByRole("heading", { name: "Pages" }).waitFor();

  // The floating Menu button is the only chrome on screen; the top bar controls
  // are off screen until it is tapped.
  const menu = page.locator(".editor-mobile-menu");
  await menu.waitFor({ state: "visible" });
  const topbarClosed = await rectOf(page, ".editor-topbar");
  if (topbarClosed !== null && topbarClosed.bottom > 8) {
    throw new Error(`mobile_editor_topbar_not_hidden:${JSON.stringify(topbarClosed)}`);
  }

  // Tapping Menu brings the controls on screen; the workflow buttons are there.
  await menu.click();
  await page.getByRole("button", { name: "Edit", exact: true }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Undo" }).waitFor({ state: "visible" });
  await settledRect(
    page, ".editor-topbar",
    (r) => r.top >= -1,
    "mobile_editor_topbar_not_shown",
  );

  // Enter Edit. The sheet closes and the page canvas fills the screen.
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editorFrame = page.frameLocator(".puck-editor-frame iframe");
  await editorFrame.getByRole("heading", { name: "Turn a good idea" }).waitFor({ state: "visible" });
  const canvas = await rectOf(page, ".editor-canvas");
  if (canvas === null || canvas.height < VIEWPORT.height * 0.7) {
    throw new Error(`mobile_editor_canvas_too_small:${JSON.stringify(canvas)}`);
  }

  // The side panel starts off screen (its top is at or below the fold).
  await settledRect(
    page, ".editor-side",
    (r) => r.top >= VIEWPORT.height - 4,
    "mobile_editor_side_not_hidden",
  );

  // The floating Page-options button opens the side sheet with page settings.
  await page.locator(".editor-panel-open").click();
  await settledRect(
    page, ".editor-side",
    (r) => r.top <= VIEWPORT.height - 120,
    "mobile_editor_side_not_shown",
  );
  // The Menu button steps aside while the sheet is open.
  if (await page.locator(".editor-mobile-menu").isVisible()) {
    throw new Error("mobile_editor_menu_not_hidden_behind_sheet");
  }
  // Done closes the sheet again.
  await page.locator(".editor-side-done").click();
  await settledRect(
    page, ".editor-side",
    (r) => r.top >= VIEWPORT.height - 4,
    "mobile_editor_side_not_closed",
  );

  // Tapping a section on the canvas selects it and leaves the canvas alone.
  // The owner edits the words by typing on the page, so a sheet must never
  // cover the text they just tapped. The section's controls stay one tap away
  // behind the Page-options button.
  await editorFrame.getByRole("heading", { name: "Turn a good idea" }).click();
  await settledRect(
    page, ".editor-side",
    (r) => r.top >= VIEWPORT.height - 4,
    "mobile_editor_sheet_covered_canvas_on_selection",
  );

  // The selected section's controls are reachable, on demand, from the button.
  await page.locator(".editor-panel-open").click();
  await page.getByRole("button", { name: "Duplicate section" }).waitFor({ state: "visible" });
  await settledRect(
    page, ".editor-side",
    (r) => r.top <= VIEWPORT.height - 120,
    "mobile_editor_section_sheet_not_shown_on_request",
  );
  await page.locator(".editor-side-done").click();
  await settledRect(
    page, ".editor-side",
    (r) => r.top >= VIEWPORT.height - 4,
    "mobile_editor_section_sheet_not_closed",
  );

  console.log(
    `Mobile editor browser acceptance passed at ${origin}: the page fills a ${VIEWPORT.width}px screen, ` +
    "the Menu button opens the top controls sheet, selecting a section leaves the canvas clear, and the " +
    "Page-options button opens the selected section's controls as a bottom sheet that Done dismisses.",
  );
} catch (error) {
  console.error("MOBILE EDITOR ACCEPTANCE FAILED:", error?.message);
  console.error(logs.join("").slice(-3000));
  process.exitCode = 1;
} finally {
  try { browser && (await browser.close()); } catch {}
  try { process.kill(-server.pid); } catch {}
}
