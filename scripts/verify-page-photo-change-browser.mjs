/**
 * Live acceptance for changing a photo while editing a page (issue #110).
 *
 * It runs the real dashboard, uploads a real photo through the real media
 * route, adds an image section to the page, and uses the "Change photo" action
 * to swap in the uploaded photo through the shared picker. It then checks that
 * the section stores the photo's media reference and that the exact draft
 * preview serves that photo through the authenticated media route. The
 * component test stubs `fetch`; this one does not, so it is the evidence that
 * the swap works end to end and rides the normal draft and preview flow.
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
        reject(new Error("page_photo_port_unavailable"));
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
        `page_photo_server_exited:${child.exitCode}\n${logs.join("")}`,
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
  throw new Error(`page_photo_server_timeout\n${logs.join("")}`);
}

function stopServer(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

/** A real PNG drawn in the page. */
async function drawPhoto(page, name, width, height) {
  return page.evaluate(
    async ([fileName, photoWidth, photoHeight]) => {
      const canvas = document.createElement("canvas");
      canvas.width = photoWidth;
      canvas.height = photoHeight;
      const context = canvas.getContext("2d");
      for (let column = 0; column < photoWidth; column += 24) {
        context.fillStyle = column % 48 === 0 ? "#2f6f4f" : "#f0e7dd";
        context.fillRect(column, 0, 24, photoHeight);
      }
      const blob = await new Promise((resolveBlob) => {
        canvas.toBlob(resolveBlob, "image/png");
      });
      const buffer = new Uint8Array(await blob.arrayBuffer());
      window.__foundryPhoto = { name: fileName, bytes: [...buffer] };
      return buffer.byteLength;
    },
    [name, width, height],
  );
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
      viewport: { width: 1180, height: 900 },
    });
    const page = await context.newPage();

    // Start a workspace and land on the page editor.
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

    // Upload a real photo so the gallery has one to choose.
    await page.goto(`${origin}/dash/media?workspace=${workspace}`);
    await page.getByRole("heading", { name: "Photos" }).waitFor();
    await drawPhoto(page, "meadow.png", 1400, 1000);
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
      throw new Error("page_photo_upload_missing_asset");
    }

    // Return to the page editor and enter edit mode.
    await page.goto(`${origin}/dash/pages?workspace=${workspace}`);
    await page.getByRole("button", { name: "Edit" }).click();

    // Add a full-width image section. Adding it selects it, so its fields —
    // including the image field — are in front of the owner at once.
    await page.locator("summary[aria-label='Add section']").click();
    await page.getByRole("button", { name: "Full-width image" }).click();

    // The image field shows a Change photo action, not a raw address to type.
    const field = page.locator(".change-photo-field");
    await field.waitFor({ state: "visible" });
    const changePhoto = field.getByRole("button", { name: "Change photo" });
    await changePhoto.waitFor({ state: "visible" });
    if ((await field.locator("input[type=text], input[type=url]").count()) > 0) {
      throw new Error("page_photo_field_is_a_raw_address_input");
    }

    // Open the shared picker and choose the uploaded photo.
    await changePhoto.click();
    const dialog = page.locator("dialog.media-picker");
    await dialog.waitFor({ state: "visible" });
    await dialog
      .locator(".media-gallery-tile", { hasText: "meadow.png" })
      .click();
    // The swap is an ordinary page edit, so it saves through the normal
    // content-revision route — no separate media path.
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/foundry-cms/revisions" &&
        response.status() === 201,
    );
    await page.getByRole("button", { name: "Use this photo" }).click();

    // The chosen photo previews in the field immediately, from the picker's
    // own thumbnail.
    await field
      .locator(".change-photo-preview img")
      .waitFor({ state: "visible" });

    // The saved revision stores the photo as its media reference.
    const savedRevision = await (await saved).json();
    const sections = savedRevision.definition?.home?.sections ?? [];
    const placed = sections.find(
      (section) =>
        section.component === "photoBand" &&
        section.props?.imageSrc === `/api/media/${asset.assetId}`,
    );
    if (placed === undefined) {
      throw new Error(
        `page_photo_reference_not_stored:${JSON.stringify(
          sections.map((section) => section.props?.imageSrc ?? section.type),
        )}`,
      );
    }

    // Open the exact draft preview and confirm it serves the chosen photo
    // through the authenticated media route.
    const previewMedia = context.waitForEvent("page").then(async (preview) => {
      const response = await preview.waitForResponse(
        (candidate) =>
          new URL(candidate.url()).pathname === "/api/foundry-cms/media" &&
          new URL(candidate.url()).searchParams.get("assetId") ===
            asset.assetId,
      );
      return { preview, response };
    });
    await page.getByRole("button", { name: /^Preview/ }).click();
    const { preview, response } = await previewMedia;
    if (response.status() !== 200) {
      throw new Error(
        `page_photo_preview_media_status:${response.status()}:${await response.text()}`,
      );
    }
    const previewImage = preview.locator(
      `img[src*="assetId=${asset.assetId}"]`,
    );
    await previewImage.first().waitFor({ state: "visible" });

    process.stdout.write(
      `Page photo change browser acceptance passed at ${origin}: ` +
        `added a full-width image section, changed its photo through the ` +
        `shared picker, stored /api/media/${asset.assetId} in the draft, and ` +
        `served that photo in the exact preview through the authenticated ` +
        `media route.\n`,
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
