/**
 * Live acceptance for campaign images (issue #112).
 *
 * It runs the real dashboard, uploads three real photos through the real media
 * route, writes an email campaign, and sets a header image, a share image and
 * an inline body image — each through the shared media picker (#109). It then
 * checks that the saved campaign carries each photo's `/api/media/<assetId>`
 * reference, and that the email preview draws the header and inline photos and
 * that the public media route actually serves them, because a campaign image is
 * meant to be seen by every recipient (ADR-0014).
 *
 * The component tests stub `fetch`; this one does not, so it is the evidence
 * that the three image controls work end to end and ride the normal draft, save
 * and preview flow.
 *
 * #110/#111 lesson: the picker's own upload and the campaign save are separate
 * requests, so this reads the campaign save's request `postData()`
 * synchronously — a successful save re-renders the page and could abort a
 * post-save response-body read — and waits for the exact `create_standalone`
 * save whose input carries all three `/api/media/<assetId>` references before
 * asserting.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

import { chromium } from "playwright";

const repositoryRoot = resolve(import.meta.dirname, "..");

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("campaign_images_port_unavailable"));
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
        `campaign_images_server_exited:${child.exitCode}\n${logs.join("")}`,
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
  throw new Error(`campaign_images_server_timeout\n${logs.join("")}`);
}

function stopServer(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

/** Draw a real PNG in the page and keep its bytes for an upload. */
async function drawPhoto(page, name, tint) {
  return page.evaluate(
    async ([fileName, colour]) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1200;
      canvas.height = 800;
      const context = canvas.getContext("2d");
      context.fillStyle = colour;
      context.fillRect(0, 0, 1200, 800);
      const blob = await new Promise((resolveBlob) => {
        canvas.toBlob(resolveBlob, "image/png");
      });
      const buffer = new Uint8Array(await blob.arrayBuffer());
      window.__foundryPhoto = { name: fileName, bytes: [...buffer] };
      return buffer.byteLength;
    },
    [name, tint],
  );
}

/** Upload the photo drawn by drawPhoto and return its asset id. */
async function uploadDrawnPhoto(page) {
  const uploaded = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/foundry-cms/media" &&
      response.status() === 201,
  );
  await page.setInputFiles(
    '.media-dropzone input[type="file"]',
    await page.evaluate(() => window.__foundryPhoto).then((photo) => ({
      name: photo.name,
      mimeType: "image/png",
      buffer: Buffer.from(photo.bytes),
    })),
  );
  const asset = await (await uploaded).json();
  if (typeof asset.assetId !== "string") {
    throw new Error("campaign_images_upload_missing_asset");
  }
  return asset.assetId;
}

/** Choose the named photo through the currently open shared picker. */
async function choosePhoto(page, fileName) {
  const dialog = page.locator("dialog.media-picker[open]");
  await dialog.waitFor({ state: "visible" });
  await dialog.locator(".media-gallery-tile", { hasText: fileName }).click();
  await dialog.getByRole("button", { name: "Use this photo" }).click();
  await dialog.waitFor({ state: "hidden" });
}

async function main() {
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
    const context = await browser.newContext({
      viewport: { width: 1180, height: 1200 },
    });
    const page = await context.newPage();

    // Choosing an inline photo triggers a window.prompt for its alt text.
    page.on("dialog", (dialog) => {
      void dialog.accept("An inline harbour photo");
    });

    // Start a workspace so the media library and picker have one.
    await page.goto(`${origin}/dash`);
    const startWorkspace = page.getByRole("button", {
      name: "Start workspace",
    });
    await startWorkspace.waitFor({ state: "visible" });
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/foundry-cms/revisions" &&
          response.status() === 201,
      ),
      startWorkspace.click(),
    ]);
    await page.waitForURL(/\/dash\/pages\?workspace=workspace_[a-f0-9]{24}$/u);
    const workspace = new URL(page.url()).searchParams.get("workspace");

    // Upload three distinct photos so the gallery has one for each control.
    await page.goto(`${origin}/dash/media?workspace=${workspace}`);
    await page.getByRole("heading", { name: "Photos", exact: true }).waitFor();
    await drawPhoto(page, "header.png", "#2f6f4f");
    const headerAsset = await uploadDrawnPhoto(page);
    await drawPhoto(page, "share.png", "#6f2f4f");
    const shareAsset = await uploadDrawnPhoto(page);
    await drawPhoto(page, "inline.png", "#2f4f6f");
    const inlineAsset = await uploadDrawnPhoto(page);

    const headerRef = `/api/media/${headerAsset}`;
    const shareRef = `/api/media/${shareAsset}`;
    const inlineRef = `/api/media/${inlineAsset}`;

    // Record every campaign save so the check can wait for the one carrying all
    // three references. Read the request postData, not the save response: a
    // successful save re-renders the composer and can abort an in-flight
    // response-body read, while the request body is available synchronously
    // when the request fires.
    const campaignSaves = [];
    page.on("request", (request) => {
      if (
        request.method() !== "POST" ||
        new URL(request.url()).pathname !== "/api/foundry-cms/campaigns"
      ) {
        return;
      }
      let command;
      try {
        command = JSON.parse(request.postData() ?? "{}");
      } catch {
        return;
      }
      const input = command.input;
      if (command.action !== "create_standalone" || typeof input !== "object") {
        return;
      }
      campaignSaves.push({
        header: input.headerImage?.url ?? "(none)",
        share: input.shareImage?.url ?? "(none)",
        body: JSON.stringify(input.emailContent ?? {}),
      });
    });

    // Go to the campaign composer. It opens by itself when there are no
    // campaigns yet.
    await page.goto(`${origin}/dash/campaigns?workspace=${workspace}`);
    await page.getByRole("heading", { name: "Newsletter" }).waitFor();
    const composer = page.locator("form.composer");
    await composer.waitFor({ state: "visible" });

    await composer.locator('input[name="subject"]').fill("Harbour dispatch");
    await composer
      .locator('textarea[name="previewText"]')
      .fill("What changed at the harbour this month.");
    await composer.locator('input[name="callToActionLabel"]').fill("Read more");
    await composer
      .locator('input[name="callToActionHref"]')
      .fill("https://example.com/read");

    // 1) Header image — through the shared picker.
    await composer
      .locator(".composer-main-image")
      .getByRole("button", { name: "Change photo" })
      .click();
    await choosePhoto(page, "header.png");
    await composer
      .locator(".composer-main-image .change-photo-preview img")
      .waitFor({ state: "visible" });
    await composer.locator('input[name="headerImageAlt"]').fill("The harbour");

    // 2) Inline image — through the body toolbar's Add photo button.
    await composer.getByRole("button", { name: "Add photo" }).click();
    await choosePhoto(page, "inline.png");
    await composer
      .locator(".rendered-rich-text img")
      .first()
      .waitFor({ state: "visible" });

    // 3) Share image — the thumbnail, set through the shared picker.
    await composer
      .locator("fieldset.composer-section")
      .getByRole("button", { name: "Change photo" })
      .click();
    await choosePhoto(page, "share.png");
    await composer.locator('input[name="shareImageAlt"]').fill("A harbour card");

    // Save the campaign. This is the one write that carries the whole email.
    await composer.getByRole("button", { name: /^Save email/u }).click();

    // Wait for the save whose input carries all three references.
    const deadline = Date.now() + 30_000;
    const carriesAll = () =>
      campaignSaves.some(
        (save) =>
          save.header === headerRef &&
          save.share === shareRef &&
          save.body.includes(inlineRef),
      );
    while (!carriesAll()) {
      if (Date.now() > deadline) {
        throw new Error(
          `campaign_images_references_not_stored:${JSON.stringify(campaignSaves)}`,
        );
      }
      await new Promise((settle) => setTimeout(settle, 200));
    }

    // The save re-renders into the campaign list. The list draws the share
    // image as a thumbnail, falling back to the header image, so the thumbnail
    // renders on a preview surface too.
    await page
      .locator(`img.campaign-thumbnail[src="${shareRef}"]`)
      .first()
      .waitFor({ state: "visible" });

    // Open the preview and confirm the header and inline photos are drawn.
    const previewButton = page.getByRole("button", { name: "Preview" });
    await previewButton.first().waitFor({ state: "visible" });
    await previewButton.first().click();
    const preview = page.locator("section.email-preview");
    await preview.waitFor({ state: "visible" });
    await preview
      .locator(`.campaign-header-image img[src="${headerRef}"]`)
      .waitFor({ state: "visible" });
    await preview
      .locator(`.rich-text-image img[src="${inlineRef}"]`)
      .first()
      .waitFor({ state: "visible" });

    // The public media route serves every campaign-referenced asset, so the
    // header, inline and share photos load in an inbox and in the preview.
    // Fetch each one directly rather than watch for a render request, because
    // a same-origin photo drawn earlier in the flow may already be cached.
    for (const [name, ref] of [
      ["header", headerRef],
      ["inline", inlineRef],
      ["share", shareRef],
    ]) {
      const response = await page.request.get(`${origin}${ref}`);
      if (response.status() !== 200) {
        throw new Error(
          `campaign_images_media_status:${name}:${response.status()}`,
        );
      }
    }

    process.stdout.write(
      `Campaign images browser acceptance passed at ${origin}: set a header ` +
        `image (${headerRef}), a share image (${shareRef}) and an inline image ` +
        `(${inlineRef}) through the shared picker, stored all three in the ` +
        `saved campaign, drew the header and inline photos in the preview and ` +
        `the share thumbnail in the list, and served all three through the ` +
        `public media route.\n`,
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
