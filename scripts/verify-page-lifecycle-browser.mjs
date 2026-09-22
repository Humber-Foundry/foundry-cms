/**
 * Live acceptance for the Pages screen: renaming, duplicating and deleting
 * pages (issue #159), the home page offering no way to delete it (issues
 * #206 and #229), and the rebuilt rows and action menus (issue #229).
 *
 * Runs the real dashboard and walks the whole journey a site owner walks to
 * get a second page: read the list, check the home page's action menu holds
 * no Delete, copy the home page to make a second one, edit it in the canvas,
 * point a navigation item at it with the page picker, follow that link inside
 * the canvas and land on the new page in the editor, open its preview, then
 * take the link away and delete the page.
 *
 * The screen has no "New page" control. Pages are added by a connected agent
 * through MCP `foundry.page.create` (ADR-0041), which
 * `apps/reference-site/src/page-lifecycle-view.test.ts` drives, so the second
 * page here is made by copying the home page.
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
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { chromium } from "playwright";

const repositoryRoot = resolve(import.meta.dirname, "..");
const screenshotDir = resolve(repositoryRoot, ".shots/verify-page-lifecycle");

/** The navigation item the journey borrows and then puts back as it was. */
const navigationItemId = "nav_work";

/**
 * The Site Definition version this repository checks against.
 *
 * It is read from the generated validator's `$id`, which `verify:site-validator`
 * keeps in step with the schema, so this journey never carries a version of
 * its own that could fall behind.
 */
function schemaVersionOfThisRepository() {
  const source = readFileSync(
    resolve(
      repositoryRoot,
      "packages/site-definition/src/site-definition-validator.mjs",
    ),
    "utf8",
  );
  const found = /schemas\/site-definition\/(\d+\.\d+\.\d+)"/u.exec(source);
  if (found === null) {
    throw new Error("page_lifecycle_schema_version_unreadable");
  }
  return found[1];
}

/**
 * Add one page the way a connected agent adds one.
 *
 * The dashboard has no "New page" control (ADR-0041). An agent adds a page by
 * calling MCP `foundry.page.create`, which runs the application's own
 * `createPage` command — the same command the revisions route runs for the
 * `create_page` operation. So this journey posts that operation straight to
 * the route, then reloads the Pages list to prove the page shows up there.
 *
 * The draft's current revision comes from the editor's own status chip,
 * which already carries it as `data-revision`.
 */
async function addPageLikeAnAgent(page, input) {
  const answer = await page.evaluate(async (wanted) => {
    const tokenAnswer = await fetch("/api/foundry-cms/revisions", {
      cache: "no-store",
    });
    const { mutationToken } = await tokenAnswer.json();
    async function post() {
      const response = await fetch("/api/foundry-cms/revisions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `agent_page:${crypto.randomUUID()}`,
          "x-foundry-csrf": mutationToken,
        },
        body: JSON.stringify({
          operation: "create_page",
          workspaceId: wanted.workspaceId,
          schemaVersion: wanted.schemaVersion,
          baseRevision: wanted.baseRevision,
          title: wanted.title,
          slug: wanted.slug,
          startingLayout: wanted.startingLayout,
        }),
      });
      const text = await response.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = { unparsed: text.slice(0, 300) };
      }
      return { status: response.status, body };
    }
    return post();
  }, input);
  if (answer.status !== 201 || typeof answer.body?.pageId !== "string") {
    throw new Error(`page_lifecycle_agent_create_refused:${JSON.stringify(answer)}`);
  }
  return answer.body.pageId;
}

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

/** Open one page row's action menu and answer the menu itself. */
async function openRowMenu(page, pageTitle) {
  const button = page.getByRole("button", { name: `Actions for ${pageTitle}` });
  await button.waitFor({ state: "visible" });
  if ((await button.getAttribute("aria-expanded")) !== "true") {
    await button.click();
  }
  const menu = page.getByRole("menu", { name: `Actions for ${pageTitle}` });
  await menu.waitFor({ state: "visible" });
  return menu;
}

/** The words on one page row's action menu, in the order they are drawn. */
async function rowMenuItems(page, pageTitle) {
  const menu = await openRowMenu(page, pageTitle);
  return menu.getByRole("menuitem").allInnerTexts();
}

/** Choose one item from a page row's action menu. */
async function chooseRowAction(page, pageTitle, label) {
  const menu = await openRowMenu(page, pageTitle);
  await menu.getByRole("menuitem", { name: label, exact: true }).click();
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
    .locator('button, a, input:not([type="radio"])')
    .evaluateAll((elements) =>
      elements
        .filter((element) => element.getBoundingClientRect().height > 0)
        .map((element) => element.getBoundingClientRect().height),
    );
  if (heights.some((height) => height < 44)) {
    throw new Error(`${reason}:${JSON.stringify(heights)}`);
  }
}

async function runJourney(origin, browser, viewport, schemaVersion) {
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

  // --- The list reads as one row per page -------------------------------
  const homeRow = page.locator(".dash-row").first();
  const homeNote = await homeRow.locator(".dash-row-note").innerText();
  if (homeNote.trim() !== "Address: /") {
    throw new Error(`page_lifecycle_home_address_not_labelled:${homeNote}`);
  }
  const homeState = await homeRow.locator(".dash-state").innerText();
  if (!["Published", "Draft changes", "Not published"].includes(homeState.trim())) {
    throw new Error(`page_lifecycle_state_word_wrong:${homeState}`);
  }

  // --- No way to add a page by hand; the screen says who adds them -------
  if ((await page.getByRole("button", { name: "New page" }).count()) !== 0) {
    throw new Error("page_lifecycle_new_page_control_present");
  }
  const agentLink = page.getByRole("link", { name: "Connect an agent" });
  await agentLink.waitFor({ state: "visible" });
  const agentHref = await agentLink.getAttribute("href");
  if (agentHref !== "/dash/settings/connect-agent") {
    throw new Error(`page_lifecycle_agent_link_wrong:${String(agentHref)}`);
  }

  // --- The home page's action menu holds no Delete ----------------------
  const homeActions = await rowMenuItems(page, "Foundry Reference");
  if (
    homeActions.map((item) => item.trim()).join(",") !== "Rename,Duplicate"
  ) {
    throw new Error(
      `page_lifecycle_home_menu_wrong:${JSON.stringify(homeActions)}`,
    );
  }
  if ((await page.locator(".help-tip-trigger").count()) !== 0) {
    throw new Error("page_lifecycle_home_row_still_has_help_tip");
  }
  const disabledControls = await page
    .locator(".dash-row button:disabled, .dash-action-menu-list button:disabled")
    .count();
  if (disabledControls !== 0) {
    throw new Error(`page_lifecycle_disabled_row_control:${disabledControls}`);
  }
  await assertTapTargets(
    page.locator(".dash-action-menu-list").first(),
    viewport,
    "page_lifecycle_home_menu_control_short",
  );
  await shot("pages-list-home-menu");
  await page.keyboard.press("Escape");

  // --- A connected agent adds a page, and the list shows it -------------
  const dialog = page.locator(".page-lifecycle-dialog");
  // The editor's status chip carries the draft's revision number, which the
  // create operation is measured against. Opening the home page to read it
  // changes nothing.
  await page.locator(".dash-row-link").first().click();
  await page.waitForURL(/[?&]page=/u);
  const revisionChip = page.locator(".state-label[data-revision]").first();
  await revisionChip.waitFor({ state: "attached", timeout: 20_000 });
  const baseRevision = Number(await revisionChip.getAttribute("data-revision"));
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
    throw new Error(`page_lifecycle_revision_unreadable:${baseRevision}`);
  }
  await page.goto(workspaceUrl);

  const pageId = await addPageLikeAnAgent(page, {
    workspaceId: new URL(workspaceUrl).searchParams.get("workspace"),
    schemaVersion,
    baseRevision,
    title: "Our services",
    slug,
    startingLayout: "introduction",
  });
  if (!/^page_[0-9a-f]{20}$/u.test(pageId)) {
    throw new Error(`page_lifecycle_page_id_not_minted:${pageId}`);
  }

  await page.goto(workspaceUrl);
  const agentRow = page.locator(".dash-row", { hasText: "Our services" });
  await agentRow.waitFor({ state: "visible", timeout: 20_000 });
  const agentRowNote = await agentRow.locator(".dash-row-note").innerText();
  if (agentRowNote.trim() !== `Address: /${slug}`) {
    throw new Error(`page_lifecycle_agent_row_address:${agentRowNote}`);
  }
  const agentRowState = await agentRow.locator(".dash-state").innerText();
  if (agentRowState.trim() !== "Not published") {
    throw new Error(`page_lifecycle_agent_row_state:${agentRowState}`);
  }
  await shot("pages-list-with-agent-page");

  // The row opens that page in the editor.
  await agentRow.locator(".dash-row-link").click();
  await page.waitForURL(new RegExp(`page=${pageId}`, "u"));
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
  await chooseRowAction(page, "Our services", "Delete");
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
  await chooseRowAction(page, "Our services", "Duplicate");
  await dialog.waitFor({ state: "visible" });
  const copyName = await page.locator("#page-lifecycle-name").inputValue();
  if (copyName !== "Our services copy") {
    throw new Error(`page_lifecycle_second_copy_not_named:${copyName}`);
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
  await chooseRowAction(page, "Our services copy", "Rename");
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
      [...document.querySelectorAll(".dash-row")].some(
        (row) =>
          (row.textContent ?? "").includes("Old news") &&
          (row.textContent ?? "").includes(address),
      ),
    `/${slug}-old`,
    { timeout: 20_000 },
  );

  const copyDeleted = savedRevision(page);
  await chooseRowAction(page, "Old news", "Delete");
  await dialog.waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Delete page" }).click();
  if ((await copyDeleted.then(() => true, () => false)) === false) {
    throw new Error(
      `page_lifecycle_copy_delete_refused:${JSON.stringify(routeAnswers)}`,
    );
  }
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".dash-row").length > 0 &&
      ![...document.querySelectorAll(".dash-row")].some((row) =>
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
  await chooseRowAction(page, "Our services", "Delete");
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
      document.querySelectorAll(".dash-row-title").length > 0 &&
      ![...document.querySelectorAll(".dash-row-title")].every((title) =>
        (title.textContent ?? "").includes("Our services"),
      ) &&
      ![...document.querySelectorAll(".dash-row-title")].some((title) =>
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
  const schemaVersion = schemaVersionOfThisRepository();
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
      await runJourney(origin, browser, viewport, schemaVersion);
    }
    process.stdout.write(
      `Page lifecycle browser acceptance passed at ${origin}: read the ` +
        `labelled address and the state on each row, found no "New page" ` +
        `control and the Connect an agent link, found no Delete in the home ` +
        `page's action menu, added a page the way a connected agent does and ` +
        `found it in the list, edited it in the canvas, pointed a ` +
        `navigation item at ` +
        `it, saw the delete refused while that link pointed at it, ` +
        `duplicated the page and renamed and deleted the copy, followed the ` +
        `navigation link inside the canvas to land on the page in the ` +
        `editor, opened its preview, then took the link away and deleted ` +
        `the page, at 1440px and 390px. Screenshots: ${screenshotDir}\n`,
    );
  } catch (error) {
    // The dashboard's own log says what the server refused and why. Without
    // it a failure here reads only as "the button was not there".
    process.stderr.write(`server log tail:\n${logs.join("").slice(-4000)}\n`);
    throw error;
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
