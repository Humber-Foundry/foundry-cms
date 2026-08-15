/**
 * Live acceptance for the photo library.
 *
 * It runs the real dashboard, uploads a real photo through the real media
 * route, and checks the gallery tile, the picker and deletion against what
 * the server actually served. The component tests stub `fetch`; this one
 * does not, so it is the evidence that upload, pick and delete work
 * end to end.
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
        reject(new Error("media_gallery_port_unavailable"));
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
        `media_gallery_server_exited:${child.exitCode}\n${logs.join("")}`,
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
  throw new Error(`media_gallery_server_timeout\n${logs.join("")}`);
}

function stopServer(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

/** A real PNG drawn in the page, large enough that a thumbnail shrinks it. */
async function drawPhoto(page, name, width, height) {
  return page.evaluate(
    async ([fileName, photoWidth, photoHeight]) => {
      const canvas = document.createElement("canvas");
      canvas.width = photoWidth;
      canvas.height = photoHeight;
      const context = canvas.getContext("2d");
      for (let column = 0; column < photoWidth; column += 24) {
        context.fillStyle = column % 48 === 0 ? "#14563d" : "#e7f0ea";
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

    await page.goto(`${origin}/dash/media?workspace=${workspace}`);
    await page.getByRole("heading", { name: "Photos" }).waitFor();

    // Upload a real photo through the real media route.
    const sourceBytes = await drawPhoto(page, "jetty.png", 1400, 1000);
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
    const uploadResponse = await uploaded;
    const asset = await uploadResponse.json();
    if (typeof asset.assetId !== "string") {
      throw new Error("media_gallery_upload_missing_asset");
    }

    // The gallery must show it as a tile, and that tile must load a resized
    // variant, not the original.
    // The picker dialog sits inside the library section and renders the same
    // gallery, so the page's own grid is the direct child list.
    const libraryTile = (fileName) =>
      page.locator("section.media-library > ul.media-gallery .media-gallery-tile", {
        hasText: fileName,
      });
    const tile = libraryTile("jetty.png");
    await tile.waitFor({ state: "visible" });
    const thumbnail = await page.waitForResponse(
      (response) =>
        response.url().includes("variant=thumbnail") &&
        response.url().includes(asset.assetId),
    );
    if (thumbnail.status() !== 200) {
      throw new Error(
        `media_gallery_thumbnail_status:${thumbnail.status()}:${await thumbnail.text()}`,
      );
    }
    if (thumbnail.headers()["x-foundry-media-variant"] !== "thumbnail") {
      throw new Error(
        `media_gallery_served_wrong_variant:${thumbnail.headers()["x-foundry-media-variant"]}`,
      );
    }
    const thumbnailBytes = (await thumbnail.body()).byteLength;
    if (thumbnailBytes >= sourceBytes) {
      throw new Error(
        `media_gallery_thumbnail_not_smaller:${thumbnailBytes}:${sourceBytes}`,
      );
    }
    const rendered = await tile.locator("img").evaluate(async (image) => {
      if (!image.complete) {
        await new Promise((settle) => {
          image.addEventListener("load", settle, { once: true });
          image.addEventListener("error", settle, { once: true });
        });
      }
      return {
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
      };
    });
    if (Math.max(rendered.naturalWidth, rendered.naturalHeight) !== 480) {
      throw new Error(
        `media_gallery_thumbnail_wrong_size:${rendered.naturalWidth}x${rendered.naturalHeight}`,
      );
    }
    const tileText = await tile.textContent();
    for (const expected of ["jetty.png", "1400×1000"]) {
      if (!tileText.includes(expected)) {
        throw new Error(`media_gallery_tile_missing:${expected}:${tileText}`);
      }
    }

    // Pick the photo through the shared picker and put it on the page.
    await page
      .getByRole("button", { name: "Choose or upload a photo…" })
      .first()
      .click();
    const dialog = page.locator("dialog.media-picker");
    await dialog.waitFor({ state: "visible" });
    await dialog
      .locator(".media-gallery-tile", { hasText: "jetty.png" })
      .click();
    const placed = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/foundry-cms/media" &&
        response.status() === 201,
    );
    await page.getByRole("button", { name: "Use this photo here" }).click();
    const placement = await (await placed).json();
    if (placement.occurrence?.assetId !== asset.assetId) {
      throw new Error(
        `media_gallery_placement_wrong_asset:${JSON.stringify(placement.occurrence)}`,
      );
    }
    await page
      .locator("section.media-library > ul.media-gallery .media-gallery-badge", {
        hasText: "On the page",
      })
      .first()
      .waitFor();

    // A photo on the page cannot be deleted.
    await tile.click();
    const deleteButton = page.getByRole("button", {
      name: "Delete selected photo",
    });
    if (await deleteButton.isEnabled()) {
      throw new Error("media_gallery_delete_guard_missing");
    }

    // A photo that is not on the page can be.
    const spareBytes = await drawPhoto(page, "spare.png", 900, 900);
    if (spareBytes <= 0) throw new Error("media_gallery_spare_not_drawn");
    const spareUploaded = page.waitForResponse(
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
    const spare = await (await spareUploaded).json();
    const spareTile = libraryTile("spare.png");
    await spareTile.waitFor({ state: "visible" });
    await spareTile.click();
    const deleted = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/foundry-cms/media" &&
        response.status() === 204,
    );
    await deleteButton.click();
    await deleted;
    await spareTile.waitFor({ state: "detached" });
    if (typeof spare.assetId !== "string") {
      throw new Error("media_gallery_spare_missing_asset");
    }

    process.stdout.write(
      `Photo library browser acceptance passed at ${origin}: ` +
        `uploaded, served a ${thumbnailBytes}-byte thumbnail for a ` +
        `${sourceBytes}-byte photo, picked it, and deleted an unused one.\n`,
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
