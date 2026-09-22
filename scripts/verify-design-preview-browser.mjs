// Design preview acceptance (#234): the Design screen loads no third-party
// script and creates no third-party frame, on first render and on every
// re-render.
//
// The check has two halves. The first drives the screen the way an owner
// does: open Design, change a design option twice, and record every console
// error and every request to a host outside the site's own origin. Both
// lists must be empty, and the newsletter section must still show its shape
// in the preview without the challenge widget.
//
// The second half proves the guard, not only the absence of a fault on the
// reference site. It puts a third-party frame and a third-party script into
// the preview by hand and checks the browser refused both under the
// dashboard's Content Security Policy before any request left it. The hosts
// end in `.invalid`, a name that never resolves, so even a broken guard
// reaches no real third party.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

import { chromium } from "playwright";

import { contentSecurityPolicyDirectives } from "./lib/content-security-policy.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

/** Hosts a component would try. `.invalid` never resolves (RFC 2606). */
const thirdPartyFrame = "https://embed.third-party.invalid/newsletter";
const thirdPartyScript = "https://script.third-party.invalid/embed.js";

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("design_preview_port_unavailable"));
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

async function waitForServer(origin, child, logs) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `design_preview_server_exited:${child.exitCode}\n${logs.join("")}`,
      );
    }
    try {
      const response = await fetch(`${origin}/`, { redirect: "manual" });
      if (response.status === 200) return;
    } catch {
      // Next has not bound the port yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`design_preview_server_timeout\n${logs.join("")}`);
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
 * The document at `path` must carry a policy that admits scripts and frames
 * from the site's own origin only. The header is the guard; the browser
 * checks below show it is enforced.
 */
async function expectDashboardPolicy(origin, path) {
  const response = await fetch(`${origin}${path}`, { redirect: "manual" });
  const policy = response.headers.get("content-security-policy");
  if (policy === null) {
    throw new Error(`design_preview_no_policy:${path}:${response.status}`);
  }
  const parsed = contentSecurityPolicyDirectives(policy);
  for (const [name, expected] of [
    ["script-src", "'self'"],
    ["frame-src", "'self'"],
    ["object-src", "'none'"],
  ]) {
    const values = parsed.get(name);
    if (values === undefined || !values.includes(expected)) {
      throw new Error(`design_preview_policy_directive:${path}:${name}:${policy}`);
    }
    if (values.some((value) => /https?:|\*/u.test(value))) {
      throw new Error(`design_preview_policy_names_a_host:${path}:${name}:${policy}`);
    }
  }
}

/**
 * The public site and the exact preview must carry no such policy: they
 * render the live challenge. The status does not matter here; the exact
 * preview needs a capability this script does not hold, and the check is
 * only that the policy stops at the dashboard's edge.
 */
async function expectNoPolicy(origin, path) {
  const response = await fetch(`${origin}${path}`, { redirect: "manual" });
  if (response.headers.get("content-security-policy") !== null) {
    throw new Error(`design_preview_policy_outside_dashboard:${path}`);
  }
}

/**
 * Records what the page did that a preview must never do: a console error,
 * an uncaught exception, or any request to a host outside the site's origin.
 * A third-party request is kept by address with what became of it: "sent"
 * until the browser reports otherwise, then the failure reason.
 */
function watch(page, origin) {
  const record = {
    consoleErrors: [],
    pageErrors: [],
    thirdPartyRequests: new Map(),
    thirdPartyResponses: [],
  };
  const outside = (url) => !url.startsWith(`${origin}/`);
  page.on("console", (message) => {
    if (message.type() === "error") {
      record.consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    record.pageErrors.push(String(error));
  });
  page.on("request", (request) => {
    if (outside(request.url())) {
      record.thirdPartyRequests.set(request.url(), "sent");
    }
  });
  page.on("requestfailed", (request) => {
    if (outside(request.url())) {
      record.thirdPartyRequests.set(
        request.url(),
        request.failure()?.errorText ?? "failed",
      );
    }
  });
  page.on("response", (response) => {
    if (outside(response.url())) {
      record.thirdPartyResponses.push(`${response.url()} ${response.status()}`);
    }
  });
  return record;
}

function expectClean(record, step) {
  const faults = [
    ...record.consoleErrors,
    ...record.pageErrors,
    ...record.thirdPartyRequests.keys(),
  ];
  if (faults.length > 0) {
    throw new Error(`design_preview_${step}:${JSON.stringify(faults)}`);
  }
}

/** What the document holds that could reach another host. */
async function outsideReferences(page) {
  return page.evaluate((own) => ({
    frames: [...document.querySelectorAll("iframe")].map(
      (frame) => frame.getAttribute("src") ?? "srcdoc",
    ),
    scripts: [...document.querySelectorAll("script[src]")]
      .map((script) => script.src)
      .filter((src) => !src.startsWith(`${own}/`)),
  }), page.url().replace(/\/dash\/design.*$/u, ""));
}

async function chooseOption(page, className, label, expectedAccent) {
  await page.locator(className, { hasText: label }).locator("input").click();
  await page
    .locator(`.design-preview .site-canvas[data-colour-accent="${expectedAccent}"]`)
    .waitFor();
}

async function main() {
  const port = await availablePort();
  if (port === 3000) throw new Error("design_preview_origin_not_distinct");
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
    await waitForServer(origin, server, logs);

    // The guard is a response header on every dashboard document, and on
    // nothing outside the dashboard.
    await expectDashboardPolicy(origin, "/dash");
    await expectDashboardPolicy(origin, "/dash/design");
    await expectNoPolicy(origin, "/");
    await expectNoPolicy(origin, "/__foundry/preview/workspace_0/1");

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    const record = watch(page, origin);

    // First render. Generous timeout: the dev server compiles the route.
    await page.goto(`${origin}/dash/design`, { timeout: 120_000 });
    await page.getByRole("heading", { name: "Start from a look" }).waitFor();
    await page.locator(".design-preview .site-canvas").waitFor();
    await page.waitForLoadState("networkidle");
    expectClean(record, "first_render");

    // The newsletter section keeps its shape in the preview, without the
    // challenge widget that only the public site and the exact preview show.
    const newsletter = page.locator(".design-preview .newsletter-section");
    if ((await newsletter.count()) !== 1) {
      throw new Error("design_preview_newsletter_section_missing");
    }
    for (const part of ["h2", "input[type=email]", "button[type=submit]"]) {
      if ((await newsletter.locator(part).count()) !== 1) {
        throw new Error(`design_preview_newsletter_shape:${part}`);
      }
    }
    if ((await newsletter.locator(".newsletter-signup-check").count()) !== 0) {
      throw new Error("design_preview_newsletter_challenge_rendered");
    }

    // Two design changes, each a re-render of the whole preview.
    await chooseOption(page, ".design-preset", "Gallery", "plum");
    await chooseOption(page, ".design-option", "Clay red", "clay");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);
    expectClean(record, "after_two_changes");

    const references = await outsideReferences(page);
    if (references.frames.length !== 0 || references.scripts.length !== 0) {
      throw new Error(
        `design_preview_outside_reference:${JSON.stringify(references)}`,
      );
    }

    // The guard itself. A component that puts a third-party frame or script
    // into the preview must be refused by the browser, with no request sent.
    await page.evaluate(
      ({ frameSrc, scriptSrc }) => {
        const preview = document.querySelector(".design-preview-page");
        if (preview === null) throw new Error("design_preview_page_missing");
        const frame = document.createElement("iframe");
        frame.src = frameSrc;
        preview.append(frame);
        const script = document.createElement("script");
        script.src = scriptSrc;
        preview.append(script);
      },
      { frameSrc: thirdPartyFrame, scriptSrc: thirdPartyScript },
    );
    await page.waitForTimeout(1_000);

    // Chrome's message names the refused frame by its origin and the refused
    // script by its full address, so both are matched by host.
    const refusals = record.consoleErrors.filter((entry) =>
      /Content Security Policy/u.test(entry),
    );
    const refused = (url) =>
      refusals.some(
        (entry) =>
          entry.includes(new URL(url).host) &&
          (entry.startsWith("Refused to frame") ||
            entry.startsWith("Refused to load the script")),
      );
    if (!refused(thirdPartyFrame) || !refused(thirdPartyScript)) {
      throw new Error(
        `design_preview_guard_did_not_refuse:${JSON.stringify(record.consoleErrors)}`,
      );
    }
    // A refused load may still surface as a request the browser itself
    // blocked; Playwright reports the reason as `csp` or as
    // `net::ERR_BLOCKED_BY_CSP`. It must never get a response.
    const escaped = [...record.thirdPartyRequests].filter(
      ([, outcome]) => !/^(?:net::ERR_BLOCKED_BY_CSP|csp)$/u.test(outcome),
    );
    if (escaped.length !== 0 || record.thirdPartyResponses.length !== 0) {
      throw new Error(
        `design_preview_guard_let_a_request_out:${JSON.stringify({
          escaped: Object.fromEntries(escaped),
          responses: record.thirdPartyResponses,
        })}`,
      );
    }
    // No frame in the page holds a document from another host. A refused
    // frame shows the browser's own error document, never the third party's.
    const frameDocuments = page
      .frames()
      .map((frame) => frame.url())
      .filter((url) => /^https?:/u.test(url) && !url.startsWith(`${origin}/`));
    if (frameDocuments.length !== 0) {
      throw new Error(
        `design_preview_guard_frame_loaded:${JSON.stringify(frameDocuments)}`,
      );
    }

    console.log(`Design preview acceptance passed at ${origin}.`);
  } finally {
    if (browser !== undefined) await browser.close();
    stopServer(server);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
});
