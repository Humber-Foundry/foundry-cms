import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";

import { chromium } from "playwright";

const repositoryRoot = resolve(import.meta.dirname, "..");

const siteStylesheet = readFileSync(
  resolve(repositoryRoot, "apps/reference-site/app/globals.css"),
  "utf8",
);

/**
 * The colour one design option declares in the site stylesheet, as the `rgb()`
 * string a browser reports.
 *
 * This script does not keep its own copy of the palette. It reads the
 * stylesheet, which `apps/reference-site/src/design-stylesheet.test.ts` already
 * binds to the design contract, and then checks the browser really delivers
 * that colour to the element in the live preview. The declaration is the
 * promise; the computed style is whether the cascade kept it.
 */
function declaredValue(attribute, value, property) {
  const selector = `.site-canvas[${attribute}="${value}"]`;
  const start = siteStylesheet.indexOf(`${selector} {`);
  if (start < 0) {
    throw new Error(`private_dashboard_design_no_rule:${selector}`);
  }
  const open = siteStylesheet.indexOf("{", start);
  const rule = siteStylesheet.slice(open + 1, siteStylesheet.indexOf("}", open));
  const declared = new RegExp(`${property}:\\s*([^;]+);`, "u").exec(rule);
  if (declared === null) {
    throw new Error(
      `private_dashboard_design_no_declaration:${selector}:${property}`,
    );
  }
  return declared[1].trim();
}

/** The same declaration as the `rgb()` string a browser reports. */
function declaredColour(attribute, value, property) {
  const declared = declaredValue(attribute, value, property);
  if (!/^#[0-9a-f]{6}$/iu.test(declared)) {
    throw new Error(`private_dashboard_design_not_a_colour:${declared}`);
  }
  const channels = Number.parseInt(declared.slice(1), 16);
  return `rgb(${(channels >> 16) & 0xff}, ${(channels >> 8) & 0xff}, ${
    channels & 0xff
  })`;
}

/** The fewest preset looks the destination may offer and still be a choice. */
const leastPresetLooks = 6;

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("private_dashboard_port_unavailable"));
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
        `private_dashboard_server_exited:${child.exitCode}\n${logs.join("")}`,
      );
    }
    try {
      const response = await fetch(`${origin}/dash`, {
        redirect: "manual",
      });
      if (response.status === 200) return;
    } catch {
      // Next has not bound the port yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`private_dashboard_server_timeout\n${logs.join("")}`);
}

function stopServer(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

async function waitForEnabled(locator, failure) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await locator.isEnabled()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(failure);
}

/** One computed style value from the live preview inside the Design page. */
async function previewStyle(page, selector, property) {
  return page
    .locator(`.design-preview ${selector}`)
    .first()
    .evaluate(
      (element, name) => getComputedStyle(element).getPropertyValue(name),
      property,
    );
}

async function expectPreviewStyle(page, selector, property, expected, failure) {
  const actual = (await previewStyle(page, selector, property)).trim();
  if (!actual.includes(expected)) {
    throw new Error(`${failure}:${property}:${actual}`);
  }
}

/**
 * The Design destination, driven the way an owner drives it: pick a preset
 * look, then fine-tune one value. Each step is checked against what the real
 * stylesheet computes in the live preview, not against the data attribute
 * alone, because the attribute is only a promise until the CSS keeps it.
 */
async function verifyDesignDestination(page) {
  await page.getByRole("navigation", { name: "Dashboard sections" })
    .getByRole("link", { name: "Design", exact: true })
    .click();
  await page.waitForURL(/\/dash\/design\?workspace=workspace_[a-f0-9]{24}$/u);
  await page.getByRole("heading", { name: "Start from a look" }).waitFor();

  const presets = await page.locator(".design-preset").count();
  if (presets < leastPresetLooks) {
    throw new Error(`private_dashboard_design_preset_count:${presets}`);
  }
  if ((await page.locator(".design-destination select").count()) !== 0) {
    throw new Error("private_dashboard_design_unlabelled_dropdown");
  }
  await page.locator(".design-preview .site-canvas").waitFor();
  await expectPreviewStyle(
    page,
    ".contact",
    "background-color",
    declaredColour("data-colour-accent", "moss", "--design-accent-deep"),
    "private_dashboard_design_initial_accent",
  );

  // Choosing a preset changes type, colour, spacing and width together.
  await page
    .locator(".design-preset", { hasText: "Gallery" })
    .locator("input")
    .click();
  await page
    .locator('.design-preview .site-canvas[data-colour-accent="plum"]')
    .waitFor();
  await expectPreviewStyle(
    page,
    ".site-canvas",
    "background-color",
    declaredColour("data-colour-neutral", "bright", "--paper"),
    "private_dashboard_design_preset_page_tone",
  );
  await expectPreviewStyle(
    page,
    ".contact",
    "background-color",
    declaredColour("data-colour-accent", "plum", "--design-accent-deep"),
    "private_dashboard_design_preset_accent",
  );
  await expectPreviewStyle(
    page,
    ".hero h1",
    "font-family",
    declaredValue("data-typography-heading", "editorial", "--design-heading-font"),
    "private_dashboard_design_preset_heading_font",
  );

  // Fine-tuning one value changes only that value, and the page says the
  // design is no longer one of the presets.
  await page
    .locator(".design-option", { hasText: "Clay red" })
    .locator("input")
    .click();
  await page
    .locator('.design-preview .site-canvas[data-colour-accent="clay"]')
    .waitFor();
  await expectPreviewStyle(
    page,
    ".contact",
    "background-color",
    declaredColour("data-colour-accent", "clay", "--design-accent-deep"),
    "private_dashboard_design_fine_tuned_accent",
  );
  await page
    .getByText("does not match any of these looks", { exact: false })
    .waitFor();
  if (
    (await page.locator(".design-preset[data-selected='true']").count()) !== 0
  ) {
    throw new Error("private_dashboard_design_preset_still_claimed");
  }

  // Content width has to change the page it is previewed on. The preview is
  // laid out wider than the widest option so the two ends are different
  // widths rather than both clamped to the preview box.
  const widthOf = async () =>
    Number.parseFloat(await previewStyle(page, ".hero", "width"));
  // Selected by value, not by label text: the Narrow option's own description
  // contains the word "wide".
  const chooseWidth = async (value) => {
    await page
      .locator(`.design-option input[name="design.layout.contentWidth"]` +
        `[value="${value}"]`)
      .click();
    await page
      .locator(
        `.design-preview .site-canvas[data-layout-content-width="${value}"]`,
      )
      .waitFor();
    return widthOf();
  };
  const narrowWidth = await chooseWidth("narrow");
  const wideWidth = await chooseWidth("wide");
  if (!(wideWidth > narrowWidth * 1.2)) {
    throw new Error(
      `private_dashboard_design_content_width_invisible:${narrowWidth}:${wideWidth}`,
    );
  }

  // Design edits are ordinary draft edits: they autosave and reach a saved
  // revision through the same toolbar Pages uses.
  await page.locator(".state-label.state-saved").waitFor({ timeout: 30_000 });
  await waitForEnabled(
    page.getByRole("button", { name: "Preview ↗" }),
    "private_dashboard_design_preview_unavailable",
  );

  const overflow = await page.locator("body").evaluate((body) => ({
    width: body.scrollWidth,
    elements: [...body.querySelectorAll("*")]
      .filter((element) => element.getBoundingClientRect().right > 390)
      .slice(0, 8)
      .map((element) => ({
        tag: element.tagName,
        className: String(element.className),
        right: element.getBoundingClientRect().right,
      })),
  }));
  if (overflow.width > 390) {
    throw new Error(
      `private_dashboard_design_mobile_overflow:${JSON.stringify(overflow)}`,
    );
  }

  await page.getByRole("navigation", { name: "Dashboard sections" })
    .getByRole("link", { name: "Overview", exact: true })
    .click();
  await page.waitForURL(/\/dash\?workspace=workspace_[a-f0-9]{24}$/u);
}

async function main() {
  const port = await availablePort();
  if (port === 3000) throw new Error("private_dashboard_origin_not_distinct");
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
    // Runs at a phone width: this test also asserts the dashboard has no
    // horizontal overflow on a phone. At this width the page editor's top bar
    // and side panel are slide-in sheets, so the helpers below open the right
    // sheet before reaching a control. The sheets' own behaviour has a
    // dedicated test: verify-mobile-editor-browser.mjs.
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    await page.goto(`${origin}/dash`);

    const startWorkspace = page.getByRole("button", {
      name: "Start workspace",
    });
    await startWorkspace.waitFor({ state: "visible" });
    const [created] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname ===
            "/api/foundry-cms/revisions",
      ),
      startWorkspace.click(),
    ]);
    if (created.status() !== 201) {
      throw new Error(
        `private_dashboard_workspace_failed:${created.status()}:${await created.text()}`,
      );
    }
    await page.waitForURL(/\/dash\/pages\?workspace=workspace_[a-f0-9]{24}$/u);
    await page.getByRole("heading", { name: "Pages" }).waitFor();

    // At a phone width the page editor's top bar and side panel are slide-in
    // sheets. These helpers open the right sheet before reaching a control, the
    // way the owner does. The Menu button is hidden while the side panel is
    // open, so opening the Menu closes the panel first.
    // A sheet is "on screen" only when its top edge is above the fold; a closed
    // sheet is translated fully off screen but still counts as visible to
    // Playwright, so position is what the helpers test.
    const sheetOnScreen = async (selector) =>
      page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el === null) return false;
        return el.getBoundingClientRect().top < 844 - 40;
      }, selector);
    const controlsOpen = async () =>
      (await page.locator(".editor-immersive")
        .getAttribute("data-mobile-controls-open")) === "true";
    const closeSidePanel = async () => {
      if (!(await sheetOnScreen(".editor-side"))) return;
      await page.locator(".editor-side-done").click({ timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(300);
    };
    const openControls = async () => {
      await closeSidePanel();
      if (await controlsOpen()) return;
      await page.locator(".editor-mobile-menu").click({ timeout: 6000 });
      await page.waitForTimeout(280);
    };
    const openSidePanel = async () => {
      if (await sheetOnScreen(".editor-side")) return;
      // On a phone the page settings sheet opens from the one editor menu.
      await openControls();
      await page.locator(".editor-menu-page-options").click({ timeout: 6000 });
      await page.waitForTimeout(320);
    };

    await waitForEnabled(
      page.getByRole("button", {
        name: "Preview ↗",
      }),
      "private_dashboard_content_editor_not_ready",
    );
    await openControls();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await openSidePanel();
    const addSection = page.locator(".add-section-menu summary");
    await addSection.click();
    await page.getByRole("button", { name: "Image and copy story" }).click();
    const editorFrame = page.frameLocator(".puck-editor-frame iframe");
    const storyHeading = editorFrame.getByRole("heading", {
      name: "Make room for a better question",
    });
    await storyHeading.waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Duplicate section" }).click();
    await page.getByRole("button", { name: "Move section down" }).click();
    await page.getByRole("button", { name: "Remove section" }).click();
    await waitForEnabled(
      addSection,
      "private_dashboard_structure_controls_locked",
    );
    const storyTitle = page.locator(
      '.puck-editor-frame input[title="Title"]:visible:not([readonly])',
    );
    for (let attempt = 0; attempt < 20 && (await storyTitle.count()) === 0; attempt += 1) {
      // Close the panel sheet first: while open it covers the lower canvas, so
      // the section heading would not be clickable. Tapping the heading then
      // re-opens the sheet to that section's fields.
      await closeSidePanel();
      await editorFrame.getByRole("heading", {
        name: "Make room for a better question",
      }).click();
      await page.waitForTimeout(300);
    }
    if ((await storyTitle.count()) !== 1) {
      throw new Error(`private_dashboard_custom_title_field_count:${await storyTitle.count()}`);
    }
    const editedStoryTitle = "The useful question is already in the room.";
    const savedResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/foundry-cms/revisions" &&
        response.status() === 201,
    );
    await storyTitle.fill(editedStoryTitle);
    await storyTitle.press("Tab");
    await editorFrame.getByRole("heading", {
      name: editedStoryTitle,
    }).waitFor({ state: "visible" });
    // Save lives in the Menu sheet at this width; open it (which closes the
    // side panel) so the control is in reach.
    await openControls();
    const saveRevision = page.getByRole("button", { name: "Save" });
    if ((await saveRevision.count()) === 1 && await saveRevision.isEnabled()) {
      await saveRevision.click();
    }
    const saved = await savedResponse;
    if (saved.status() !== 201) {
      throw new Error(
        `private_dashboard_save_failed:${saved.status()}:${await saved.text()}`,
      );
    }
    const savedPayload = await saved.json();
    if (typeof savedPayload.revision !== "number") {
      throw new Error("private_dashboard_saved_revision_missing");
    }
    const savedRevision = savedPayload.revision;
    await page.locator(
      `.state-label.state-saved[data-revision="${savedRevision}"]`,
    ).waitFor();
    // Preview is in the Menu sheet too; keep it open for the click.
    await openControls();
    const [preview] = await Promise.all([
      context.waitForEvent("page"),
      page.getByRole("button", {
        name: "Preview ↗",
      }).click(),
    ]);
    await preview.waitForURL(
      new RegExp(`/__foundry/preview/workspace_[a-f0-9]{24}/${savedRevision}\\?`, "u"),
    );
    await preview.getByRole("heading", { name: editedStoryTitle }).waitFor();
    if ((await preview.locator(".story-section").count()) !== 1) {
      throw new Error("private_dashboard_preview_custom_renderer_missing");
    }
    const publicPage = await context.newPage();
    await publicPage.goto(origin);
    await publicPage.getByRole("heading", {
      name: "Turn a good idea into something people can use.",
    }).waitFor();
    if ((await publicPage.locator(".story-section").count()) !== 0) {
      throw new Error("private_dashboard_unapproved_component_was_public");
    }
    const overflow = await page.locator("body").evaluate((body) => ({
      width: body.scrollWidth,
      elements: [...body.querySelectorAll("*")]
        .filter((element) => element.getBoundingClientRect().right > 390)
        .slice(0, 8)
        .map((element) => ({
          tag: element.tagName,
          className: element.className,
          right: element.getBoundingClientRect().right,
          width: element.getBoundingClientRect().width,
        })),
    }));
    if (overflow.width > 390) {
      throw new Error(
        `private_dashboard_mobile_horizontal_overflow:${JSON.stringify(overflow)}`,
      );
    }
    // The Dashboard link is in the Menu sheet too.
    await openControls();
    await page.getByRole("link", { name: "← Dashboard" }).click();
    await page.waitForURL(/\/dash\?workspace=workspace_[a-f0-9]{24}$/u);
    await verifyDesignDestination(page);
    await page.getByRole("navigation", { name: "Dashboard sections" })
      .getByRole("link", { name: "Blog", exact: true })
      .click();
    await page.waitForURL(/\/dash\/blog\?workspace=workspace_[a-f0-9]{24}$/u);
    await page.getByRole("heading", { name: "Blog", exact: true }).waitFor();
    await page.getByRole("heading", { name: "Posts", exact: true }).waitFor();
    const blogTitle = page.locator('.composer input[name="title"]');
    await blogTitle.waitFor();
    if (!(await blogTitle.isEnabled())) {
      throw new Error("private_dashboard_blog_controls_disabled");
    }
    const createPost = page.getByRole("button", { name: "Save draft" });
    if (!(await createPost.isEnabled())) {
      throw new Error("private_dashboard_blog_submit_disabled");
    }
    process.stdout.write(
      `Private dashboard browser acceptance passed at ${origin}.\n`,
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
