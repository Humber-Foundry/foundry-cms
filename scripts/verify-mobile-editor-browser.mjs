// Phone editor acceptance: on a narrow screen the page fills the screen and
// the editor chrome lives in slide-in sheets.
//
// The docked, desktop workflow is covered by verify-private-dashboard-browser.
// This test drives the phone layout: a floating Menu opens the top controls,
// Page options inside that menu opens the side panel as a bottom sheet, and
// Done closes it. It asserts the sheets actually move on and off screen, not
// merely that the markup exists.

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

// The editor menu is the one way into the page settings sheet on a phone: tap
// Menu, then Page options. There is no second floating button.
async function openPageOptions(page) {
  await page.locator(".editor-mobile-menu").click();
  await page.locator(".editor-menu-page-options").click();
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

  // Menu -> Page options opens the side sheet with page settings.
  await openPageOptions(page);
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
  // behind Menu -> Page options.
  await editorFrame.getByRole("heading", { name: "Turn a good idea" }).click();
  await settledRect(
    page, ".editor-side",
    (r) => r.top >= VIEWPORT.height - 4,
    "mobile_editor_sheet_covered_canvas_on_selection",
  );

  // The selected section's controls are reachable, on demand, from the menu.
  await openPageOptions(page);
  await page.getByRole("button", { name: "Duplicate section" }).waitFor({ state: "visible" });
  await settledRect(
    page, ".editor-side",
    (r) => r.top <= VIEWPORT.height - 120,
    "mobile_editor_section_sheet_not_shown_on_request",
  );
  // Opening the sheet moves focus into it. The control that opened it lives in
  // the editor menu, and opening the sheet closes that menu, so focus left
  // behind would sit on a button that has slid off screen.
  const focusInSheet = await page.evaluate(() => {
    const panel = document.querySelector(".editor-side");
    return panel !== null && panel.contains(document.activeElement);
  });
  if (!focusInSheet) throw new Error("mobile_editor_sheet_did_not_take_focus");

  await page.locator(".editor-side-done").click();
  await settledRect(
    page, ".editor-side",
    (r) => r.top >= VIEWPORT.height - 4,
    "mobile_editor_section_sheet_not_closed",
  );

  // Leaving Edit with the sheet open must not strand the editor. The phone
  // stylesheet hides Menu while the panel sheet is up, so a flag left true by
  // an earlier edit hid Menu in Browse, where there is no sheet to close it —
  // no way back without a reload. Reached by opening the sheet, widening to
  // where the top bar is in view, switching to Browse, and narrowing again.
  await openPageOptions(page);
  await page.setViewportSize({ width: 1000, height: VIEWPORT.height });
  await page.getByRole("button", { name: "Browse", exact: true }).click();
  await page.setViewportSize(VIEWPORT);
  await page.locator(".editor-mobile-menu").waitFor({ state: "visible", timeout: 5000 })
    .catch(() => { throw new Error("mobile_editor_menu_lost_after_browse"); });
  // Back into Edit for the checks below.
  await page.locator(".editor-mobile-menu").click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await editorFrame.getByRole("heading", { name: "Turn a good idea" })
    .waitFor({ state: "visible" });

  // A panel taller than the sheet must scroll rather than squeeze what is in
  // it. Left to shrink, a group compresses while a field inside keeps its own
  // height: the field paints over the controls below it and the sheet reports
  // nothing to scroll, so Add section at the foot cannot be reached at all.
  // The proof section carries the most fields; on a shorter phone its panel is
  // taller than the sheet.
  await page.setViewportSize({ width: VIEWPORT.width, height: 700 });
  await editorFrame
    .getByText("The best handoff is not a folder of files.", { exact: false })
    .click();
  await openPageOptions(page);
  await page.getByRole("button", { name: "Duplicate section" }).waitFor({ state: "visible" });
  const addSection = page.locator(".add-section-menu summary");
  await addSection.scrollIntoViewIfNeeded();
  // Polled: the sheet is still settling right after it scrolls, so one sample
  // can hit whatever was at that point mid-scroll.
  const uncovered = async () => addSection.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit === el || el.contains(hit);
  });
  const coveredDeadline = Date.now() + 4000;
  let addSectionReachable = await uncovered();
  while (!addSectionReachable && Date.now() < coveredDeadline) {
    await new Promise((r) => setTimeout(r, 150));
    await addSection.scrollIntoViewIfNeeded().catch(() => {});
    addSectionReachable = await uncovered();
  }
  if (!addSectionReachable) throw new Error("mobile_editor_add_section_covered");
  await addSection.click({ timeout: 10_000 });
  const addSectionOpen = await page.locator(".add-section-menu").evaluate((el) => el.open);
  if (!addSectionOpen) throw new Error("mobile_editor_add_section_did_not_open");

  // The squeeze is what puts a control out of reach, and it hides itself: a
  // sheet whose children have been compressed reports nothing to scroll even
  // though its content is taller than it is.
  const tallPanel = await page.locator(".editor-side").evaluate((el) => ({
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
  }));
  if (tallPanel.scrollHeight <= tallPanel.clientHeight) {
    throw new Error(
      `mobile_editor_tall_panel_squeezed_instead_of_scrolling:${JSON.stringify(tallPanel)}`,
    );
  }
  await page.setViewportSize(VIEWPORT);

  console.log(
    `Mobile editor browser acceptance passed at ${origin}: the page fills a ${VIEWPORT.width}px screen, ` +
    "the Menu button opens the top controls sheet, selecting a section leaves the canvas clear, and " +
    "Page options in that one menu opens the selected section's controls as a bottom sheet that Done dismisses. "
    + "A panel taller than the sheet scrolls, and Add section at its foot stays reachable.",
  );
} catch (error) {
  console.error("MOBILE EDITOR ACCEPTANCE FAILED:", error?.message);
  console.error(logs.join("").slice(-3000));
  process.exitCode = 1;
} finally {
  try { browser && (await browser.close()); } catch {}
  try { process.kill(-server.pid); } catch {}
}
