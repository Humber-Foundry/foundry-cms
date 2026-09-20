/**
 * Live acceptance for creating, renaming, duplicating and deleting pages
 * (issue #159), and for the home page row offering no way to delete it
 * (issue #206).
 *
 * Runs the real dashboard and walks the whole journey a site owner walks to
 * get a second page: check that the home page row's Delete control is
 * disabled and explains why, make a page from the Pages list, edit it in the
 * canvas, point a navigation item at it with the page picker, follow that
 * link inside the canvas and land on the new page in the editor, open its
 * preview, then take the link away and delete the page.
 *
 * Following a link inside the canvas is the end-to-end check ADR-0024 left
 * for this ticket, because until now the reference site had one page and a
 * link to the page already open opens nothing.
 *
 * Screenshots at 1440px and 390px so the owner's design rules can be checked
 * by eye, not only by markup.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { chromium } from "playwright";

const repositoryRoot = resolve(import.meta.dirname, "..");
const screenshotDir = resolve(repositoryRoot, ".shots/verify-page-lifecycle");

/** The navigation item the journey borrows and then puts back as it was. */
const navigationItemId = "nav_work";

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("page_lifecycle_port_unavailable"));
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
        `page_lifecycle_server_exited:${child.exitCode}\n${logs.join("")}`,
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
  throw new Error(`page_lifecycle_server_timeout\n${logs.join("")}`);
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
 * A saved revision answered by the content route.
 *
 * The wait is started before the action that causes it, so its rejection is
 * swallowed here as well: an unhandled rejection would end the process before
 * the dev server could be stopped, and leave it running for the next agent.
 */
function savedRevision(page) {
  const waiting = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/foundry-cms/revisions" &&
      response.status() === 201,
  );
  waiting.catch(() => {});
  return waiting;
}

/** Opens one field card if it is not open already; safe on desktop or phone. */
async function openFieldCard(page, heading) {
  const toggle = page.locator(".editor-group-toggle", { hasText: heading });
  if ((await toggle.count()) === 0) return;
  const expanded = await toggle.first().getAttribute("aria-expanded");
  if (expanded !== "true") await toggle.first().click();
}

/** Puts the editor into Edit mode, opening the phone menu first when needed. */
async function startEditing(page, viewport) {
  if (viewport.name === "390") {
    await page.locator(".editor-mobile-menu").click();
  }
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  if (viewport.name === "390") {
    await page.locator(".editor-mobile-menu").click();
    await page.locator(".editor-menu-page-options").click();
  }
}

/**
 * One toolbar button, with the phone menu opened first when it is hiding it.
 *
 * The menu is only opened when the button is not already on screen, because
 * pressing the menu when it is open closes it again.
 */
async function toolbarButton(page, name) {
  const button = page.getByRole("button", { name }).first();
  if (await button.isVisible().catch(() => false)) return button;
  await page.locator(".editor-mobile-menu").click();
  await button.waitFor({ state: "visible" });
  return button;
}

/**
 * Every control in a dialog is a 44px tap target on a phone.
 *
 * A radio button is measured through the label that wraps it, because the
 * whole label is what the owner taps; the round mark itself is only what they
 * look at.
 */
async function assertTapTargets(locator, viewport, reason) {
  if (viewport.name !== "390") return;
  const heights = await locator
    .locator(
      'button, a, input:not([type="radio"]), .page-lifecycle-layouts label',
    )
    .evaluateAll((elements) =>
      elements
        .filter((element) => element.getBoundingClientRect().height > 0)
        .map((element) => element.getBoundingClientRect().height),
    );
  if (heights.some((height) => height < 44)) {
    throw new Error(`${reason}:${JSON.stringify(heights)}`);
  }
}

async function runJourney(origin, browser, viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  // Every answer the content route gives, so a failure can say what happened
  // instead of only that something did not.
  const routeAnswers = [];
  page.on("response", (response) => {
    if (
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/foundry-cms/revisions"
    ) {
      routeAnswers.push(`${response.status()}`);
    }
  });
  const shot = (name) =>
    page.screenshot({
      path: resolve(screenshotDir, `${name}-${viewport.name}.png`),
      fullPage: false,
    });
  // Each viewport works in the same server-side draft, so the two passes use
  // different web addresses and each one puts the draft back as it found it.
  const slug = `our-services-${viewport.name}`;

  // The dashboard creates the draft workspace on the server, so Overview
  // links straight into Pages.
  await page.goto(`${origin}/dash`);
  await page.getByRole("link", { name: /^(Start|Continue) editing$/u }).click();
  await page.waitForURL(/\/dash\/pages\?workspace=workspace_[a-f0-9]{24}$/u);
  const workspaceUrl = page.url();
  await shot("pages-list");

  // --- The home page row offers no way to delete it ---------------------
  const homeDeleteButton = page.getByRole("button", {
    name: /^Delete Foundry Reference$/u,
  });
  if (!(await homeDeleteButton.isDisabled())) {
    throw new Error("page_lifecycle_home_delete_not_disabled");
  }
  const homeDeleteTip = page.getByRole("button", {
    name: "Why can't I delete the home page?",
  });
  await homeDeleteTip.waitFor({ state: "visible" });
  await homeDeleteTip.click();
  const homeDeleteExplanation = page.locator(".help-tip-panel");
  await homeDeleteExplanation.waitFor({ state: "visible" });
  const explanationText = await homeDeleteExplanation.innerText();
  if (!explanationText.includes("The home page cannot be deleted")) {
    throw new Error(`page_lifecycle_home_delete_not_explained:${explanationText}`);
  }
  await assertTapTargets(
    page.locator(".pages-list-row-actions").first(),
    viewport,
    "page_lifecycle_home_row_control_short",
  );
  await shot("pages-list-home-delete-explained");
  // Close the tip so it does not sit open over the rest of the journey.
  await homeDeleteTip.click();

  // --- Create -----------------------------------------------------------
  await page.getByRole("button", { name: "New page" }).click();
  const dialog = page.locator(".page-lifecycle-dialog");
  await dialog.waitFor({ state: "visible" });
  await page.locator("#page-lifecycle-name").fill("Our services");
  // The web address follows the page name until the owner types their own.
  const suggested = await page.locator("#page-lifecycle-address").inputValue();
  if (suggested !== "our-services") {
    throw new Error(`page_lifecycle_address_not_suggested:${suggested}`);
  }
  await page.locator("#page-lifecycle-address").fill(slug);
  await page.locator('input[name="startingLayout"][value="introduction"]').check();
  await assertTapTargets(dialog, viewport, "page_lifecycle_new_control_short");
  await shot("new-page-dialog");

  // A successful create sends the browser straight to the new page in the
  // editor, so the answer is read from the address rather than from the
  // response body, which the navigation discards.
  await page.getByRole("button", { name: "Create page" }).click();
  await page.waitForURL(/[?&]page=page_[0-9a-f]{20}$/u);
  const pageId = new URL(page.url()).searchParams.get("page");
  if (pageId === null || !/^page_[0-9a-f]{20}$/u.test(pageId)) {
    throw new Error(`page_lifecycle_page_id_not_minted:${String(pageId)}`);
  }
  if (pageId === "home") {
    throw new Error("page_lifecycle_page_id_is_home");
  }
  await shot("new-page-in-editor");

  // --- Edit it in the canvas -------------------------------------------
  await startEditing(page, viewport);
  await openFieldCard(page, "Hero");
  const heroTitle = page
    .locator(`[data-field-path="${pageId}.${pageId}_hero.title"]`)
    .locator("input, textarea")
    .first();
  await heroTitle.waitFor({ state: "visible" });
  const edited = savedRevision(page);
  await heroTitle.fill("What we do for you");
  const editedBody = await (await edited).json();
  const editedPage = (editedBody.definition?.pages ?? []).find(
    (candidate) => candidate.id === pageId,
  );
  const editedHero = (editedPage?.sections ?? []).find(
    (section) => section.type === "hero",
  );
  if (editedHero?.title !== "What we do for you") {
    throw new Error(
      `page_lifecycle_canvas_edit_not_saved:${JSON.stringify(editedHero)}`,
    );
  }
  await shot("new-page-edited");

  // --- Link to it from the navigation ----------------------------------
  await openFieldCard(page, "Navigation");
  const hrefField = page
    .locator(`[data-field-path="${navigationItemId}.href"] .site-href-field`)
    .first();
  await hrefField.waitFor({ state: "visible" });
  const selects = hrefField.locator("select");
  await selects.first().selectOption("page");
  await openFieldCard(page, "Navigation");
  const linked = savedRevision(page);
  await selects.nth(1).selectOption(pageId);
  const linkedBody = await (await linked).json();
  const linkedNav = (linkedBody.definition?.site?.navigation ?? []).find(
    (item) => item.id === navigationItemId,
  );
  if (linkedNav?.href !== `page:${pageId}`) {
    throw new Error(
      `page_lifecycle_navigation_link_not_saved:${JSON.stringify(linkedNav)}`,
    );
  }
  const homePageId = homePageIdOf(linkedBody);
  const createdPage = (linkedBody.definition?.pages ?? []).find(
    (candidate) => candidate.id === pageId,
  );
  if (createdPage?.slug !== slug) {
    throw new Error(
      `page_lifecycle_page_not_created:${JSON.stringify(createdPage)}`,
    );
  }
  // The "Introduction" starting point is an opening banner and a call to
  // action, each named after the page that holds it.
  if (
    createdPage.sections.length !== 2 ||
    createdPage.sections.some((section) => !section.id.startsWith(pageId))
  ) {
    throw new Error(
      `page_lifecycle_starting_layout_wrong:${JSON.stringify(
        createdPage.sections.map((section) => section.id),
      )}`,
    );
  }

  // --- Delete is refused while the link points at the page --------------
  // Loading the list afresh also leaves Edit mode, because the editor always
  // opens in browse mode.
  await page.goto(workspaceUrl);
  const deleteButton = page.getByRole("button", {
    name: "Delete Our services",
  });
  await deleteButton.click();
  await dialog.waitFor({ state: "visible" });
  const blockers = dialog.locator(".page-lifecycle-blockers a");
  if ((await blockers.count()) === 0) {
    throw new Error("page_lifecycle_delete_not_blocked_by_link");
  }
  const blockerName = await blockers.first().innerText();
  if (!blockerName.startsWith("Navigation")) {
    throw new Error(`page_lifecycle_blocker_not_named:${blockerName}`);
  }
  const submitDisabled = await dialog
    .getByRole("button", { name: "Delete page" })
    .isDisabled();
  if (!submitDisabled) {
    throw new Error("page_lifecycle_blocked_delete_not_disabled");
  }
  await assertTapTargets(dialog, viewport, "page_lifecycle_delete_control_short");
  await shot("delete-blocked");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // --- Duplicate, rename, then take the copy away ----------------------
  await page.getByRole("button", { name: "Duplicate Our services" }).click();
  await dialog.waitFor({ state: "visible" });
  const copyName = await page.locator("#page-lifecycle-name").inputValue();
  if (copyName !== "Our services copy") {
    throw new Error(`page_lifecycle_copy_not_named:${copyName}`);
  }
  await page.locator("#page-lifecycle-address").fill(`${slug}-copy`);
  await assertTapTargets(dialog, viewport, "page_lifecycle_copy_control_short");
  await shot("duplicate-dialog");
  await page.getByRole("button", { name: "Duplicate page" }).click();
  await page.waitForURL(/[?&]page=page_[0-9a-f]{20}$/u);
  const copyId = new URL(page.url()).searchParams.get("page");
  if (copyId === null || copyId === pageId) {
    throw new Error(`page_lifecycle_copy_shares_page_id:${String(copyId)}`);
  }

  await page.goto(workspaceUrl);
  await page.getByRole("button", { name: "Rename Our services copy" }).click();
  await dialog.waitFor({ state: "visible" });
  await page.locator("#page-lifecycle-name").fill("Old news");
  await page.locator("#page-lifecycle-address").fill(`${slug}-old`);
  await shot("rename-dialog");
  const renamed = savedRevision(page);
  await page.getByRole("button", { name: "Save changes" }).click();
  if ((await renamed.then(() => true, () => false)) === false) {
    throw new Error(
      `page_lifecycle_rename_refused:${JSON.stringify(routeAnswers)}`,
    );
  }
  await page.waitForFunction(
    (address) =>
      [...document.querySelectorAll(".pages-list-row")].some(
        (row) =>
          (row.textContent ?? "").includes("Old news") &&
          (row.textContent ?? "").includes(address),
      ),
    `/${slug}-old`,
    { timeout: 20_000 },
  );

  const copyDeleted = savedRevision(page);
  await page.getByRole("button", { name: "Delete Old news" }).click();
  await dialog.waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Delete page" }).click();
  if ((await copyDeleted.then(() => true, () => false)) === false) {
    throw new Error(
      `page_lifecycle_copy_delete_refused:${JSON.stringify(routeAnswers)}`,
    );
  }
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".pages-list-row").length > 0 &&
      ![...document.querySelectorAll(".pages-list-row")].some((row) =>
        (row.textContent ?? "").includes("Old news"),
      ),
    null,
    { timeout: 20_000 },
  );

  // --- Follow the link inside the canvas -------------------------------
  await page.goto(`${workspaceUrl}&page=${homePageId}`);
  const canvasLink = page
    .locator(".editor-browse a")
    .filter({ hasText: linkedNav.label })
    .first();
  await canvasLink.waitFor({ state: "visible" });
  await canvasLink.click();
  await page.waitForURL(new RegExp(`page=${pageId}`, "u"));
  await shot("followed-canvas-link");

  // --- Open its preview -------------------------------------------------
  if (viewport.name === "390") {
    await page.locator(".editor-mobile-menu").click();
  }
  // Opening the preview answers 200 with the address of the previewed
  // revision. The page's own preview is that address with the page's web
  // address on the end; the query must be carried across, because it holds
  // what lets the preview be read at all. See ADR-0029.
  const previewOpened = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/foundry-cms/revisions" &&
      response.ok(),
  );
  previewOpened.catch(() => {});
  const previewButton = await toolbarButton(
    page,
    /Preview|Open the last save/u,
  );
  try {
    await previewButton.click({ timeout: 10_000 });
  } catch {
    const buttons = await page.locator("button").allInnerTexts();
    await shot("preview-button-missing");
    throw new Error(
      `page_lifecycle_preview_button_missing:${JSON.stringify(buttons)}`,
    );
  }
  const previewResponse = await previewOpened.then(
    (answer) => answer,
    () => null,
  );
  if (previewResponse === null) {
    throw new Error(
      `page_lifecycle_preview_no_answer:${JSON.stringify(routeAnswers)}`,
    );
  }
  const previewBody = await previewResponse.json();
  if (typeof previewBody.previewUrl !== "string") {
    throw new Error(
      `page_lifecycle_preview_not_opened:${JSON.stringify(previewBody)}`,
    );
  }
  const revisionPreview = new URL(previewBody.previewUrl, origin);
  const pagePreview = new URL(revisionPreview.toString());
  pagePreview.pathname = `${revisionPreview.pathname}/${slug}`;
  const previewPage = await context.newPage();
  await previewPage.goto(pagePreview.toString());
  const previewText = await previewPage.locator("body").innerText();
  if (!previewText.includes("What we do for you")) {
    throw new Error(
      `page_lifecycle_preview_missing_page:${previewText.slice(0, 300)}`,
    );
  }
  await previewPage.screenshot({
    path: resolve(screenshotDir, `preview-${viewport.name}.png`),
  });
  await previewPage.close();

  // --- Take the link away, then delete ---------------------------------
  await page.goto(`${workspaceUrl}&page=${homePageId}`);
  await startEditing(page, viewport);
  await openFieldCard(page, "Navigation");
  await hrefField.waitFor({ state: "visible" });
  const unlinked = savedRevision(page);
  await hrefField.locator("select").first().selectOption("blog");
  await (await unlinked).json();

  await page.goto(workspaceUrl);
  await page.getByRole("button", { name: "Delete Our services" }).click();
  await dialog.waitFor({ state: "visible" });
  if ((await dialog.locator(".page-lifecycle-blockers a").count()) !== 0) {
    throw new Error("page_lifecycle_delete_still_blocked");
  }
  await shot("delete-confirm");
  // A successful delete comes back to the list, which is the address the
  // browser is already on, so waiting for the address to change would prove
  // nothing. Wait for the answer, then for the row to leave the reloaded
  // list.
  const deleted = savedRevision(page);
  await dialog.getByRole("button", { name: "Delete page" }).click();
  const deletedAnswer = await deleted.then(
    (answer) => answer,
    () => null,
  );
  if (deletedAnswer === null) {
    throw new Error(
      `page_lifecycle_delete_refused:${JSON.stringify(routeAnswers)}`,
    );
  }
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".pages-list-title").length > 0 &&
      ![...document.querySelectorAll(".pages-list-title")].every((title) =>
        (title.textContent ?? "").includes("Our services"),
      ) &&
      ![...document.querySelectorAll(".pages-list-title")].some((title) =>
        (title.textContent ?? "").includes("Our services"),
      ),
    null,
    { timeout: 20_000 },
  );
  await shot("pages-list-after-delete");

  await context.close();
  return pageId;
}

/** The home page's id in a saved definition. */
function homePageIdOf(body) {
  const home = (body.definition?.pages ?? []).find(
    (candidate) => candidate.slug === "",
  );
  if (home === undefined) throw new Error("page_lifecycle_home_page_missing");
  return home.id;
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
      await runJourney(origin, browser, viewport);
    }
    process.stdout.write(
      `Page lifecycle browser acceptance passed at ${origin}: created a page ` +
        `from the Pages list with a minted id, edited it in the canvas, ` +
        `pointed a navigation item at it, saw the delete refused while that ` +
        `link pointed at it, duplicated the page and renamed and deleted the ` +
        `copy, followed the navigation link inside the canvas to land on the ` +
        `page in the editor, opened its preview, then took the link away and ` +
        `deleted the page, at 1440px and 390px. Screenshots: ${screenshotDir}\n`,
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
