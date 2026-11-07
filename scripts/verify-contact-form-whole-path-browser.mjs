import { withWorkerHarness } from "./lib/worker-harness.mjs";

/**
 * A visitor's contact message, followed from the public home page to the
 * Messages screen, against the built Worker and a local D1 database.
 *
 * The visitor uses the real Turnstile widget with Cloudflare's test site key,
 * and the Worker's siteverify call reaches Cloudflare with the test secret.
 * The owner is signed in through the harness's Access stand-in (ADR-0050).
 *
 * `--reuse-build` skips the build when the current source has just been
 * built, as Product CI does.
 */

const sender = "Ada Lovelace";
const message = `Please call me back about the workshop (${Date.now()}).`;

// The Worker files a message sent sooner than this after the form appeared
// as suspected spam, so the visitor takes a little longer, as a person does.
const visitorFillTimeMs = 3_000;

async function sendTheContactForm(harness) {
  const page = await harness.newVisitorPage();
  await page.goto(`${harness.origin}/`, { waitUntil: "domcontentloaded" });
  const form = page.locator(".contact-form-section");
  await form.waitFor();

  const name = form.locator('[name="name"]');
  await name.waitFor();
  for (let attempt = 0; !(await name.isEnabled()); attempt += 1) {
    if (attempt > 300) throw new Error("contact_form_never_ready");
    await new Promise((wait) => setTimeout(wait, 100));
  }
  // The form takes its start time when it renders in the browser, which is
  // before its fields are enabled. Timing from here keeps the gap long enough.
  const ready = Date.now();
  await name.fill(sender);
  await form.locator('[name="email"]').fill("ada@example.com");
  await form.locator('[name="message"]').fill(message);

  // The form sends nothing until the Turnstile widget has handed it a token.
  // The widget also writes that token into this hidden field.
  await page.waitForFunction(
    () =>
      document.querySelector(
        '.contact-form-section input[name="cf-turnstile-response"]',
      )?.value,
    undefined,
    { timeout: 30_000 },
  );
  const waited = Date.now() - ready;
  if (waited < visitorFillTimeMs) {
    await new Promise((wait) => setTimeout(wait, visitorFillTimeMs - waited));
  }
  const sent = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/forms/contact/submissions",
  );
  await page.locator(".contact-form-button").click();
  const response = await sent;
  if (response.status() !== 201) {
    throw new Error(`contact_form_send_status:${response.status()}`);
  }
  await page.getByText("Thank you", { exact: false }).waitFor();
  await page.context().close();
}

async function readTheMessageInMessages(harness) {
  const page = await harness.newSignedInPage();
  const response = await page.goto(`${harness.origin}/dash/forms`, {
    waitUntil: "domcontentloaded",
  });
  if (response?.status() !== 200) {
    throw new Error(`messages_status:${response?.status()}`);
  }
  await page.getByRole("heading", { name: "Messages", level: 1 }).waitFor();

  const item = page.locator(".message-item").filter({ hasText: message });
  await item.waitFor();
  const itemText = (await item.textContent()) ?? "";
  if (!itemText.includes(sender)) {
    throw new Error(`messages_item_without_sender:${itemText}`);
  }

  const unread = page.locator("section[aria-labelledby='inbox'] > p").first();
  const unreadLine = ((await unread.textContent()) ?? "").trim();
  if (unreadLine !== "1 message you have not read yet.") {
    throw new Error(`messages_unread_line:${unreadLine}`);
  }

  const row = page
    .locator('ul[aria-label="Forms on your site"] .dash-row')
    .filter({ hasText: "Contact form" });
  const note = ((await row.locator(".dash-row-note").textContent()) ?? "")
    .trim();
  if (!note.endsWith(" 1 message received.")) {
    throw new Error(`messages_count_line:${note}`);
  }
  await page.context().close();
}

try {
  await withWorkerHarness(
    {
      build: !process.argv.includes("--reuse-build"),
      turnstileAction: "contact",
    },
    async (harness) => {
      await sendTheContactForm(harness);
      await readTheMessageInMessages(harness);
      if (harness.refusedOutbound.length > 0) {
        throw new Error(
          `worker_sent_unexpected_requests:${harness.refusedOutbound.join(", ")}`,
        );
      }
    },
  );
  process.stdout.write("contact form whole path: ok\n");
} catch (error) {
  process.stderr.write(`${error?.stack ?? String(error)}\n`);
  process.exitCode = 1;
}
