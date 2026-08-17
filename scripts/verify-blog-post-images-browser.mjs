/**
 * Live acceptance for blog post images (issue #111).
 *
 * It runs the real dashboard, uploads three real photos through the real media
 * route, writes a blog post, and sets a main image, a thumbnail and an inline
 * body image — each through the shared media picker (#109). It then checks that
 * the saved post revision stores each photo's `/api/media/<assetId>` reference
 * and that the exact draft preview serves those photos through the
 * authenticated media route and renders them.
 *
 * The component tests stub `fetch`; this one does not, so it is the evidence
 * that the three image controls work end to end and ride the normal draft,
 * save and preview flow.
 *
 * #110 lesson: the picker's own upload and the post save are separate requests,
 * so this waits for the exact `create_blog_post` save whose stored definition
 * carries all three `/api/media/<assetId>` references before asserting, rather
 * than racing an earlier save.
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
        reject(new Error("blog_images_port_unavailable"));
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
        `blog_images_server_exited:${child.exitCode}\n${logs.join("")}`,
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
  throw new Error(`blog_images_server_timeout\n${logs.join("")}`);
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
async function uploadDrawnPhoto(page, origin) {
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
    throw new Error("blog_images_upload_missing_asset");
  }
  return asset.assetId;
}

/** Choose the named photo through the currently open shared picker. */
async function choosePhoto(page, fileName) {
  const dialog = page.locator("dialog.media-picker[open]");
  await dialog.waitFor({ state: "visible" });
  await dialog
    .locator(".media-gallery-tile", { hasText: fileName })
    .click();
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

    // Start a workspace.
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
    await page.getByRole("heading", { name: "Photos" }).waitFor();
    await drawPhoto(page, "main.png", "#2f6f4f");
    const mainAsset = await uploadDrawnPhoto(page, origin);
    await drawPhoto(page, "thumb.png", "#6f2f4f");
    const thumbAsset = await uploadDrawnPhoto(page, origin);
    await drawPhoto(page, "inline.png", "#2f4f6f");
    const inlineAsset = await uploadDrawnPhoto(page, origin);

    // The three references the saved post must carry.
    const mainRef = `/api/media/${mainAsset}`;
    const thumbRef = `/api/media/${thumbAsset}`;
    const inlineRef = `/api/media/${inlineAsset}`;

    // Record every blog-post save so the check can wait for the one that
    // carries all three references, rather than racing an earlier save.
    // Read the create-post request body, not the save response. A successful
    // save immediately calls window.location.assign, which tears the page
    // down and can abort an in-flight response-body read; the request's
    // postData is available synchronously when the request fires, before any
    // navigation, so it is race-free. The body carries the exact references
    // the owner is storing through the shared picker.
    const postSaves = [];
    page.on("request", (request) => {
      if (
        request.method() !== "POST" ||
        new URL(request.url()).pathname !== "/api/foundry-cms/revisions"
      ) {
        return;
      }
      let command;
      try {
        command = JSON.parse(request.postData() ?? "{}");
      } catch {
        return;
      }
      const post = command.post;
      if (
        command.operation !== "create_blog_post" ||
        typeof post !== "object" ||
        post === null ||
        post.slug !== "harbour-notes"
      ) {
        return;
      }
      postSaves.push({
        main: post.mainImage?.url ?? "(none)",
        thumb: post.seo?.shareImage?.url ?? "(none)",
        body: typeof post.body === "string" ? post.body : JSON.stringify(post.body ?? {}),
      });
    });

    // Go to the blog composer. The composer opens by itself when the blog is
    // empty.
    await page.goto(`${origin}/dash/blog?workspace=${workspace}`);
    await page.getByRole("heading", { name: "Posts" }).waitFor();
    const composer = page.locator("form.composer");
    await composer.waitFor({ state: "visible" });

    await composer.locator('input[name="title"]').fill("Harbour notes");

    // 1) Main image — through the shared picker.
    await composer
      .locator(".composer-main-image")
      .getByRole("button", { name: "Change photo" })
      .click();
    await choosePhoto(page, "main.png");
    await composer
      .locator(".composer-main-image .change-photo-preview img")
      .waitFor({ state: "visible" });
    await composer
      .locator('input[name="mainImageAlt"]')
      .fill("The harbour");

    // 2) Inline image — through the body toolbar's Add photo button. Choosing
    // the photo triggers a window.prompt for the alt text, which is accepted.
    page.on("dialog", (dialog) => {
      void dialog.accept("An inline harbour photo");
    });
    await composer.getByRole("button", { name: "Add photo" }).click();
    await choosePhoto(page, "inline.png");
    // The inline image lands in the body before we go on, so the save cannot
    // race ahead of it.
    await composer
      .locator(".rendered-rich-text img")
      .first()
      .waitFor({ state: "visible" });

    // 3) Thumbnail — the SEO share image, set through the shared picker.
    const seoDetails = composer.locator("details.composer-settings", {
      hasText: "SEO and sharing",
    });
    await seoDetails.locator("summary").click();
    await seoDetails
      .getByRole("button", { name: "Change photo" })
      .click();
    await choosePhoto(page, "thumb.png");

    // Save the draft. This is the one content-revision write that carries the
    // whole post.
    await composer.getByRole("button", { name: /^Save draft/u }).click();

    // Wait for the save whose stored definition carries all three references.
    const deadline = Date.now() + 30_000;
    const carriesAll = () =>
      postSaves.some(
        (save) =>
          save.main === mainRef &&
          save.thumb === thumbRef &&
          save.body.includes(inlineRef),
      );
    while (!carriesAll()) {
      if (Date.now() > deadline) {
        throw new Error(
          `blog_images_references_not_stored:${JSON.stringify(postSaves)}`,
        );
      }
      await new Promise((settle) => setTimeout(settle, 200));
    }

    // A successful save reloads the blog list itself (window.location.assign),
    // so wait for that reload rather than starting a second navigation that
    // would race it. The post then lists with its Preview action.
    await page.waitForURL(
      /\/dash\/blog\?workspace=workspace_[a-f0-9]{24}$/u,
      { timeout: 30_000 },
    );
    await page.getByRole("heading", { name: "Posts" }).waitFor();
    const previewButton = page.getByRole("button", { name: "Preview ↗" });
    await previewButton.first().waitFor({ state: "visible" });

    const previewMedia = context.waitForEvent("page").then(async (preview) => {
      const response = await preview.waitForResponse(
        (candidate) =>
          new URL(candidate.url()).pathname === "/api/foundry-cms/media" &&
          new URL(candidate.url()).searchParams.get("assetId") === mainAsset,
      );
      return { preview, response };
    });
    await previewButton.first().click();
    const { preview, response } = await previewMedia;
    if (response.status() !== 200) {
      throw new Error(
        `blog_images_preview_media_status:${response.status()}:${await response.text()}`,
      );
    }
    // The main image renders in the header and the inline image in the body,
    // each through the authenticated media route.
    await preview
      .locator(`.blog-post-main-image img[src*="assetId=${mainAsset}"]`)
      .first()
      .waitFor({ state: "visible" });
    await preview
      .locator(`.rich-text-image img[src*="assetId=${inlineAsset}"]`)
      .first()
      .waitFor({ state: "visible" });

    process.stdout.write(
      `Blog post images browser acceptance passed at ${origin}: set a main ` +
        `image (${mainRef}), a thumbnail (${thumbRef}) and an inline image ` +
        `(${inlineRef}) through the shared picker, stored all three in the ` +
        `saved post, and served the main and inline photos in the exact ` +
        `preview through the authenticated media route.\n`,
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
