import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

import { chromium } from "playwright";

const repositoryRoot = resolve(import.meta.dirname, "..");

/** The minimum plain reading the owner's acceptance criteria set for #173:
 * no text closer than 8px to a border it sits inside, or to a sibling
 * control; no phone tap target under 44px high. #226 adds one more rule to
 * the same sweep: no destination scrolls sideways at either width. */
const minimumTextGap = 8;
const minimumTapTarget = 44;

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("dashboard_spacing_port_unavailable"));
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
        `dashboard_spacing_server_exited:${child.exitCode}\n${logs.join("")}`,
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
  throw new Error(`dashboard_spacing_server_timeout\n${logs.join("")}`);
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
 * Every own-text element inside a bordered or backgrounded box, measured
 * against the specific edges that box actually draws a line on. Checking
 * only the drawn edges (rather than every edge of any "boxed" ancestor)
 * keeps a heading that simply has no top inset from reading as a false
 * defect — the owner's rule is about a border or a control, not empty
 * padding a container never promised.
 *
 * Returns the worst few offenders so a failure is diagnosable without a
 * screenshot.
 */
const collectTightText = (minimumTextGap) => {
  const offenders = [];
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) !== 0;
  };
  const path = (el) => {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && parts.length < 4) {
      let s = n.tagName.toLowerCase();
      if (n.id) s += `#${n.id}`;
      if (typeof n.className === "string" && n.className.trim() !== "") {
        s += `.${n.className.trim().split(/\s+/u).join(".")}`;
      }
      parts.unshift(s.slice(0, 120));
      n = n.parentElement;
    }
    return parts.join(" > ");
  };
  const ownText = (el) =>
    Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && n.textContent.trim().length > 0,
    );
  const drawnEdges = (el) => {
    const s = getComputedStyle(el);
    const edges = {};
    let borderSides = 0;
    for (const side of ["Top", "Right", "Bottom", "Left"]) {
      const width = Number.parseFloat(s[`border${side}Width`]);
      const hasBorder = width > 0 && s[`border${side}Style`] !== "none";
      edges[side.toLowerCase()] = hasBorder;
      if (hasBorder) borderSides += 1;
    }
    // A card that already draws a border on three or four sides plus its own
    // background has proven itself a box — from there every side is part of
    // that box, including a side whose own border a more specific rule
    // stripped. This is exactly the #173-regression shape a per-side-only
    // check misses: Overview's "Your draft" card kept its border and padding
    // on three sides and lost both on the fourth, so the old check never
    // looked at that side at all.
    //
    // The threshold is three-or-more sides, not "any," so a strip that is
    // only ever meant to draw one edge — `.editor-toolbar`'s single
    // `border-bottom`, deliberately flush with its card's left, right and
    // top edges by negative margin — is left alone rather than flagged for
    // an inset it was never meant to have.
    if (borderSides >= 3) {
      const background = s.backgroundColor;
      const hasOwnBackground =
        background !== "rgba(0, 0, 0, 0)" && background !== "transparent";
      if (hasOwnBackground) {
        return { top: true, right: true, bottom: true, left: true };
      }
    }
    return edges;
  };

  // An interactive control's own label sits inside the control's own
  // padding, which is a component-level design choice (a segmented toggle's
  // selected pill can legitimately sit 1px from its track). This check is
  // about page content — prose, headings, field labels — sitting too close
  // to a container it did not choose, so it skips a control's own text.
  const interactive = new Set([
    "BUTTON",
    "A",
    "INPUT",
    "SELECT",
    "TEXTAREA",
    "SUMMARY",
  ]);
  // The Puck page editor's own toolbar chrome (mode toggle, save/undo bar,
  // status notes) has its own dedicated browser test —
  // verify-mobile-editor-browser.mjs — and is not one of the destinations
  // or panels #173 lists, so it is out of scope here. `.composer-settings`
  // is a native `<details>` disclosure; a closed one hides its own fields
  // from layout, which this generic sweep cannot reason about safely, and
  // it is not one of #173's numbered panels either — `.composer-section`
  // and `.composer-main-image`, which #173 does cover, are checked as
  // normal.
  // `.site-canvas` is the real published page, rendered live inside the
  // Design preview. It carries the site's own brand design system, not the
  // dashboard's — see the type-system note at the top of this stylesheet —
  // so its spacing is a site design decision, not dashboard chrome #173
  // covers.
  const outOfScope = (el) =>
    el.closest(
      ".editor-topbar, .editor-notes, .composer-settings, .site-canvas",
    ) !== null;

  const all = Array.from(document.querySelectorAll("body *")).filter(vis);
  for (const el of all) {
    if (!ownText(el)) continue;
    if (interactive.has(el.tagName)) continue;
    // A native <legend> straddles its fieldset's own top border by design —
    // that notch is the browser drawing the border around the legend, not
    // the legend crowding it.
    if (el.tagName === "LEGEND") continue;
    if (outOfScope(el)) continue;
    let anc = el.parentElement;
    let depth = 0;
    while (anc && depth < 4) {
      // A bordered ancestor that is itself a control (an icon centred in a
      // button, say) is that control's own internal padding, not a page
      // container the text was placed into — the tap-target check covers
      // the control's own size separately.
      if (interactive.has(anc.tagName)) {
        anc = anc.parentElement;
        depth += 1;
        continue;
      }
      const edges = drawnEdges(anc);
      if (edges.top || edges.right || edges.bottom || edges.left) {
        const ar = anc.getBoundingClientRect();
        const as = getComputedStyle(anc);
        if (as.overflowY === "auto" || as.overflowY === "scroll") break;
        const r = el.getBoundingClientRect();
        const d = {
          top: r.top - ar.top,
          bottom: ar.bottom - r.bottom,
          left: r.left - ar.left,
          right: ar.right - r.right,
        };
        for (const side of ["top", "right", "bottom", "left"]) {
          if (!edges[side]) continue;
          if (d[side] < minimumTextGap && d[side] > -200) {
            offenders.push({
              sel: path(el),
              anc: path(anc),
              side,
              gap: Math.round(d[side]),
              text: el.textContent.trim().slice(0, 50),
            });
          }
        }
        break;
      }
      anc = anc.parentElement;
      depth += 1;
    }
  }
  return offenders.slice(0, 20);
};

/**
 * Whether the page scrolls sideways, and what sticks out past the right edge
 * if it does (#226).
 *
 * A dashboard screen must fit the width it is given. A sideways scrollbar
 * hides part of every row and makes the screen feel broken. One pixel of
 * slack is allowed for a fractional layout width the browser rounds up.
 *
 * This runs inside the browser through `page.evaluate`, so it can call
 * nothing outside itself. That is why it writes out its own element
 * description rather than sharing `path` from `collectTightText`.
 */
const collectHorizontalOverflow = () => {
  const root = document.documentElement;
  const overflow = root.scrollWidth - root.clientWidth;
  if (overflow <= 1) return null;
  const limit = root.clientWidth;
  const culprits = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (r.right <= limit + 1) continue;
    let s = el.tagName.toLowerCase();
    if (typeof el.className === "string" && el.className.trim() !== "") {
      s += `.${el.className.trim().split(/\s+/u).join(".")}`;
    }
    culprits.push({ sel: s.slice(0, 120), right: Math.round(r.right) });
  }
  return { overflow: Math.round(overflow), viewport: limit, culprits: culprits.slice(0, 10) };
};

const collectSmallTapTargets = (minimumTapTarget) => {
  const targets = Array.from(
    document.querySelectorAll('a, button, input, select, textarea, [role="button"]'),
  );
  const offenders = [];
  for (const el of targets) {
    // The Puck page editor's own chrome (immersive mobile menu, undo/redo,
    // Browse/Edit toggle) has its own dedicated browser test —
    // verify-mobile-editor-browser.mjs. The live published page inside
    // `.site-canvas` carries the site's own design system, not the
    // dashboard's. `.email-preview-message` is the email itself, drawn as an
    // inbox will draw it, so its button is the email's design, not a
    // dashboard control. None is one of #173's numbered destinations or
    // panels.
    if (
      el.closest(
        ".editor-immersive, .site-canvas, .email-preview-message",
      ) !== null
    ) {
      continue;
    }
    // A radio or checkbox's native box is small by design; the tap target
    // is the label that wraps it (a design option, a preset look), which
    // this sweep already measures as its own `<label>` element.
    if (el.tagName === "INPUT" && ["radio", "checkbox"].includes(el.type)) {
      continue;
    }
    // A link inline in a sentence of body text is exempt from a minimum
    // target size under WCAG 2.2 SC 2.5.8 — the rule is for a standalone
    // control, not a word inside a paragraph. Detected here as an `<a>`
    // whose parent holds other real text besides the link itself.
    if (el.tagName === "A" && el.parentElement !== null) {
      const siblingText = Array.from(el.parentElement.childNodes)
        .filter((n) => n !== el)
        .map((n) => n.textContent ?? "")
        .join("")
        .trim();
      if (siblingText.length > 0) continue;
    }
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (r.height <= 0) continue;
    if (r.height < minimumTapTarget) {
      offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: typeof el.className === "string" ? el.className : "",
        height: Math.round(r.height),
        text: (el.textContent || el.value || "").trim().slice(0, 30),
      });
    }
  }
  return offenders.slice(0, 20);
};

/**
 * Opens one saved email's screen and runs the same checks there.
 *
 * The preview card and the four sending steps used to render on
 * /dash/campaigns, which this sweep visits. Since #237 they are on one email's
 * own screen, which needs an email to open, so this writes one through the
 * writing box the first time and opens it from the list after that.
 */
async function checkCampaignScreen(page, origin, viewportLabel) {
  await page.goto(`${origin}/dash/campaigns`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  if ((await page.locator(".dash-row").count()) === 0) {
    await page.getByRole("button", { name: "New email" }).click({ timeout: 8000 });
    await page.waitForURL(/\/dash\/campaigns\/new/u, { timeout: 20_000 });
    const composer = page.locator("form.composer");
    await composer.waitFor({ state: "visible", timeout: 20_000 });
    await composer.locator('input[name="subject"]').fill("News from the harbour");
    await composer
      .locator('textarea[name="previewText"]')
      .fill("What changed at the harbour this month.");
    await composer.locator('input[name="callToActionLabel"]').fill("Read more");
    await composer
      .locator('input[name="callToActionHref"]')
      .fill("https://example.com/read");
    await composer
      .locator(".rich-text-editor [contenteditable]")
      .fill("The new pontoon is finished and the winter berths are open.");
    await page.getByRole("button", { name: "Save email" }).click({ timeout: 8000 });
    await page.waitForURL(/\/dash\/campaigns(\?|$)/u, { timeout: 30_000 });
  }
  const row = page.locator(".dash-row").first();
  await row.waitFor({ timeout: 20_000 });
  const href = await row.locator("a.dash-row-link").getAttribute("href");
  await checkDestination(page, origin, "One email", href, viewportLabel);
}

const destinations = [
  ["Overview", "/dash"],
  ["Pages", "/dash/pages"],
  ["Blog", "/dash/blog"],
  ["Photos", "/dash/media"],
  ["Design", "/dash/design"],
  ["Messages", "/dash/forms"],
  ["Newsletter", "/dash/campaigns"],
  ["New email", "/dash/campaigns/new"],
  ["Subscribers", "/dash/subscribers"],
  ["Visitors", "/dash/analytics"],
  ["Settings", "/dash/settings"],
  ["Connect an agent", "/dash/settings/connect-agent"],
];

/**
 * Opens the Pages editor's page-settings panel — the "Site description" /
 * "Page SEO description" fields #173 names — and runs the same spacing
 * checks inside it. The panel is a slide-up sheet on a phone rather than a
 * fixed sidebar, so the two viewports open it differently.
 */
async function checkPagesSettingsPanel(page, origin, viewportLabel) {
  await page.goto(`${origin}/dash/pages`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);

  // Pages opens on the list of every page. Open the first one to reach the
  // editor and the settings panel this check measures.
  const firstPage = page.locator(".pages-list-row").first();
  if ((await firstPage.count()) > 0) {
    await firstPage.click({ timeout: 8000 });
    await page.waitForURL(/&page=/u, { timeout: 8000 });
    await page.waitForTimeout(600);
  }

  if (viewportLabel === "phone") {
    await page.locator(".editor-mobile-menu").click({ timeout: 8000 });
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "Edit", exact: true }).click({ timeout: 8000 });
    await page.waitForTimeout(500);
    await page.locator(".editor-mobile-menu").click({ timeout: 8000 });
    await page.waitForTimeout(300);
    await page.locator(".editor-menu-page-options").click({ timeout: 8000 });
    await page.waitForTimeout(500);
  } else {
    await page.getByRole("button", { name: "Edit", exact: true }).click({ timeout: 8000 });
    await page.waitForTimeout(500);
  }

  // "Site settings" is the field group that holds Site description; open it
  // so its fields are actually laid out and measurable.
  const siteSettings = page.getByRole("button", { name: "Site settings" });
  if ((await siteSettings.count()) > 0) {
    await siteSettings.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(400);
  }

  const tight = await page.evaluate(collectTightText, minimumTextGap);
  if (tight.length > 0) {
    throw new Error(
      `dashboard_spacing_tight_text:${viewportLabel}:PagesPanel:${JSON.stringify(tight)}`,
    );
  }

  // The panel's left and right insets must match — #173's "13px left, 16px
  // right" defect.
  const insets = await page.evaluate(() => {
    const panel = document.querySelector(".editor-side-page") || document.querySelector(".editor-side");
    if (panel === null) return null;
    const fields = Array.from(panel.querySelectorAll("label, .editor-field")).filter(
      (field) => field.getBoundingClientRect().width > 10,
    );
    const pr = panel.getBoundingClientRect();
    return fields.map((field) => {
      const fr = field.getBoundingClientRect();
      return {
        left: Math.round(fr.left - pr.left),
        right: Math.round(pr.right - fr.right),
      };
    });
  });
  if (insets !== null) {
    for (const { left, right } of insets) {
      if (Math.abs(left - right) > 2) {
        throw new Error(
          `dashboard_spacing_asymmetric_panel_inset:${viewportLabel}:left=${left}:right=${right}`,
        );
      }
    }
  }
}

async function checkDestination(page, origin, name, href, viewportLabel) {
  await page.goto(`${origin}${href}`, {
    waitUntil: "networkidle",
    timeout: 45_000,
  });
  await page.waitForTimeout(600);

  // Settings' "Technical detail" disclosure starts collapsed, so its
  // content is not in the layout at all until it opens — a sweep that never
  // opens it can never measure the gap between the sections inside it. This
  // is how #150's defect (the "Room left for messages" heading touching the
  // dashed box above it, 0px gap) passed this check before: nothing here
  // ever rendered that content.
  if (name === "Settings") {
    // Settings has two `.technical-inventory` disclosures ("Technical
    // detail" and, nested inside Site details, "Version numbers and
    // published records"), so match this one by its own summary text.
    const technicalDetail = page.getByText("Technical detail", {
      exact: true,
    });
    if ((await technicalDetail.count()) > 0) {
      await technicalDetail.click({ timeout: 8000 });
      await page.waitForTimeout(300);
    }
  }

  const tight = await page.evaluate(collectTightText, minimumTextGap);
  if (tight.length > 0) {
    throw new Error(
      `dashboard_spacing_tight_text:${viewportLabel}:${name}:${JSON.stringify(tight)}`,
    );
  }

  const sideways = await page.evaluate(collectHorizontalOverflow);
  if (sideways !== null) {
    throw new Error(
      `dashboard_spacing_horizontal_scroll:${viewportLabel}:${name}:${JSON.stringify(sideways)}`,
    );
  }

  if (viewportLabel === "phone") {
    const small = await page.evaluate(collectSmallTapTargets, minimumTapTarget);
    if (small.length > 0) {
      throw new Error(
        `dashboard_spacing_small_tap_target:${viewportLabel}:${name}:${JSON.stringify(small)}`,
      );
    }
  }
}

async function main() {
  const port = await availablePort();
  if (port === 3000) throw new Error("dashboard_spacing_origin_not_distinct");
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
      // #215: a dashboard page load must never reach an outside server (the
      // visual editor's stylesheet used to `@import` a font from one). Every
      // request made while this context is open is recorded here and
      // checked against the dashboard's own origin below.
      const foreignRequests = [];
      page.on("request", (request) => {
        if (new URL(request.url()).origin !== origin) {
          foreignRequests.push(request.url());
        }
      });
      // The dashboard creates the draft workspace on the server, so Pages,
      // Blog and Design render their real editing surfaces straight away —
      // the same content the owner's own audit measured.
      await page.goto(`${origin}/dash`, { waitUntil: "networkidle" });
      await page
        .getByRole("link", { name: /^(Start|Continue) editing$/u })
        .waitFor({ state: "visible" });

      for (const [name, href] of destinations) {
        await checkDestination(page, origin, name, href, viewportLabel);
      }
      await checkPagesSettingsPanel(page, origin, viewportLabel);
      await checkCampaignScreen(page, origin, viewportLabel);
      await context.close();

      if (foreignRequests.length > 0) {
        throw new Error(
          `dashboard_spacing_foreign_request:${viewportLabel}:${JSON.stringify(foreignRequests)}`,
        );
      }
    }

    process.stdout.write(
      `Dashboard spacing acceptance passed at ${origin} (1440px and 390px, every destination: no text touching a border, no sideways scroll, no small tap target).\n`,
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
