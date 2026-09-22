import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

import { chromium } from "playwright";

const repositoryRoot = resolve(import.meta.dirname, "..");

/**
 * The contact form, driven the way a visitor drives it, and the Messages
 * screen the owner then reads.
 *
 * Two things this script cannot use on a development machine, and stands in
 * for instead:
 *
 * - The real Cloudflare Turnstile widget. It is served from Cloudflare and
 *   needs a real site key, so the script serves a stand-in script at the same
 *   address that hands the form a token straight away.
 * - The deployed D1 database and rate limiter. `next dev` has neither, so the
 *   form's status request and its send are answered by this script, which
 *   then checks the exact request the route would have received.
 *
 * What the real route does with that request is covered by
 * `app/api/forms/[formId]/submissions/route.test.ts`, and what the stored
 * message looks like in the inbox is covered by
 * `src/contact-form-to-inbox.test.ts` against a migrated database.
 */

const turnstileAddress =
  "https://challenges.cloudflare.com/turnstile/v0/api.js*";

const standInTurnstile = `
  window.turnstile = {
    render(element, options) {
      options.callback("browser-token");
      return "widget-1";
    },
    reset() {},
  };
`;

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("contact_form_port_unavailable"));
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

async function waitForSite(origin, child, logs) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `contact_form_server_exited:${child.exitCode}\n${logs.join("")}`,
      );
    }
    try {
      const response = await fetch(`${origin}/`, { redirect: "manual" });
      if (response.status === 200) return;
    } catch {
      // Next has not bound the port yet.
    }
    await new Promise((wait) => setTimeout(wait, 250));
  }
  throw new Error(`contact_form_server_timeout\n${logs.join("")}`);
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
 * Answer the two requests a development machine cannot answer, and keep every
 * send so the script can check what the route would have received.
 */
async function standInForTheDeployment(page) {
  const sends = [];
  await page.route(turnstileAddress, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: standInTurnstile,
    }),
  );
  await page.route("**/api/forms/*/submissions", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          available: true,
          schemaVersion: "1.0.0",
          turnstileAction: "contact",
          turnstileSiteKey: "0xSTANDIN",
        }),
      });
      return;
    }
    sends.push({ url: request.url(), body: request.postDataJSON() });
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ receiptId: "receipt_standin" }),
    });
  });
  return sends;
}

async function verifyVisitorCanSendAMessage(page, origin, sends) {
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".contact-form-section").waitFor();
  const heading = await page
    .locator(".contact-form-section h2")
    .first()
    .textContent();
  if ((heading ?? "").trim() === "") {
    throw new Error("contact_form_no_heading");
  }

  const name = page.locator('.contact-form-section [name="name"]');
  await name.waitFor();
  for (let attempt = 0; !(await name.isEnabled()); attempt += 1) {
    if (attempt > 120) throw new Error("contact_form_never_ready");
    await new Promise((wait) => setTimeout(wait, 100));
  }

  await name.fill("Ada");
  await page.locator('.contact-form-section [name="email"]').fill(
    "ada@example.com",
  );
  await page
    .locator('.contact-form-section [name="message"]')
    .fill("Please call me back about the workshop.");
  await page.locator(".contact-form-button").click();

  await page.getByText("Thank you", { exact: false }).waitFor();
  if ((await page.locator(".contact-form-fields").count()) !== 0) {
    throw new Error("contact_form_still_shown_after_send");
  }

  if (sends.length !== 1) {
    throw new Error(`contact_form_send_count:${sends.length}`);
  }
  const [sent] = sends;
  if (new URL(sent.url).pathname !== "/api/forms/contact/submissions") {
    throw new Error(`contact_form_wrong_address:${sent.url}`);
  }
  const expected = {
    name: "Ada",
    email: "ada@example.com",
    message: "Please call me back about the workshop.",
  };
  if (JSON.stringify(sent.body.fields) !== JSON.stringify(expected)) {
    throw new Error(
      `contact_form_wrong_fields:${JSON.stringify(sent.body.fields)}`,
    );
  }
  if (sent.body.honeypot !== "" || sent.body.turnstileToken !== "browser-token") {
    throw new Error("contact_form_missing_guard_values");
  }
  if (sent.body.schemaVersion !== "1.0.0") {
    throw new Error(`contact_form_wrong_schema:${sent.body.schemaVersion}`);
  }
}

async function verifyMessagesListsTheForm(page, origin) {
  await page.goto(`${origin}/dash/forms`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Forms on your site" }).waitFor();
  const row = page.locator(".site-form-item").first();
  await row.waitFor();
  const name = (await row.locator(".site-form-name").textContent()) ?? "";
  if (name.trim() !== "Contact form") {
    throw new Error(`contact_form_dashboard_name:${name}`);
  }
  const detail = (await row.locator(".site-form-detail").textContent()) ?? "";
  if (!detail.includes("message")) {
    throw new Error(`contact_form_dashboard_no_count:${detail}`);
  }
  const placement = row.locator(".site-form-page").first();
  if ((await placement.count()) !== 1) {
    throw new Error("contact_form_dashboard_no_page_named");
  }
  if ((await placement.getAttribute("href")) !== "/") {
    throw new Error("contact_form_dashboard_wrong_page_link");
  }
}

async function main() {
  const shotDirectory = process.env.FOUNDRY_SHOT_DIRECTORY ?? null;
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
    await waitForSite(origin, server, logs);
    browser = await chromium.launch({ headless: true });

    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      const sends = await standInForTheDeployment(page);
      await verifyVisitorCanSendAMessage(page, origin, sends);
      if (shotDirectory !== null) {
        await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
        await page.locator(".contact-form-section").scrollIntoViewIfNeeded();
        await page.locator(".contact-form-section").screenshot({
          path: `${shotDirectory}/contact-form-${viewport.width}.png`,
        });
      }
      await verifyMessagesListsTheForm(page, origin);
      if (shotDirectory !== null) {
        await page.screenshot({
          path: `${shotDirectory}/messages-${viewport.width}.png`,
          fullPage: true,
        });
      }
      await context.close();
    }
    process.stdout.write("contact form: ok\n");
  } catch (error) {
    process.stderr.write(`${String(error)}\n${logs.join("")}\n`);
    process.exitCode = 1;
  } finally {
    if (browser !== undefined) await browser.close();
    stopServer(server);
  }
}

await main();
