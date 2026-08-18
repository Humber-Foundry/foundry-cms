/**
 * Live acceptance for the photo picker listing every photo the site uses, not
 * only uploads (issue #132).
 *
 * The old picker showed "No photos yet" whenever the library held no uploaded
 * asset, even when the site already displayed photos. This runs the real
 * dashboard, gives the site a built-in photo by adding a full-width image
 * section (its default is a built-in image, not a library asset), lets it save,
 * then opens the shared picker in the blog composer and checks that the built-in
 * photo is listed as a selectable "Built-in site image" tile and can be chosen —
 * placing an existing photo on the post without uploading anything.
 *
 * The component test stubs `fetch`; this one does not, so it is the evidence
 * that site-used photos reach the picker through the real server, the same set
 * the Photos gallery shows via `site-used-photos`.
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
        reject(new Error("picker_site_photos_port_unavailable"));
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
        `picker_site_photos_server_exited:${child.exitCode}\n${logs.join("")}`,
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
  throw new Error(`picker_site_photos_server_timeout\n${logs.join("")}`);
}

function stopServer(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
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
      viewport: { width: 1180, height: 1000 },
    });
    const page = await context.newPage();

    // Start a workspace and land on the page editor.
    await page.goto(`${origin}/dash`);
    const startWorkspace = page.getByRole("button", { name: "Start workspace" });
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

    // Give the site a built-in photo: a full-width image section defaults to a
    // built-in image (not a library asset). Adding the section autosaves it, so
    // watch for the save whose stored definition carries the built-in address.
    let builtInSaved = false;
    page.on("response", (response) => {
      if (
        response.request().method() !== "POST" ||
        new URL(response.url()).pathname !== "/api/foundry-cms/revisions" ||
        response.status() !== 201
      ) {
        return;
      }
      void response
        .json()
        .then((body) => {
          const section = (body.definition?.home?.sections ?? []).find(
            (candidate) => candidate.component === "photoBand",
          );
          if (
            section !== undefined &&
            typeof section.props?.imageSrc === "string" &&
            section.props.imageSrc.includes("foundry-gathering")
          ) {
            builtInSaved = true;
          }
        })
        .catch(() => undefined);
    });

    await page.getByRole("button", { name: "Edit" }).click();
    await page.locator("summary[aria-label='Add section']").click();
    await page.getByRole("button", { name: "Full-width image" }).click();

    const savedDeadline = Date.now() + 30_000;
    while (!builtInSaved) {
      if (Date.now() > savedDeadline) {
        throw new Error("picker_site_photos_built_in_not_saved");
      }
      await new Promise((settle) => setTimeout(settle, 200));
    }

    // Reload the blog composer. Its picker's site photos come from the saved
    // draft, so the built-in image the page now uses is offered here.
    await page.goto(`${origin}/dash/blog?workspace=${workspace}`);
    const composer = page.locator("form.composer");
    await composer.waitFor({ state: "visible" });
    await composer
      .locator(".composer-main-image")
      .getByRole("button", { name: "Change photo" })
      .click();

    const dialog = page.locator("dialog.media-picker[open]");
    await dialog.waitFor({ state: "visible" });

    // The built-in photo is listed as a selectable "Built-in site image" tile —
    // the picker shows every photo the site uses, not only uploads.
    const siteTile = dialog
      .locator(".media-gallery-tile-site")
      .filter({ hasText: "Built-in site image" })
      .filter({ hasText: "foundry-gathering.svg" });
    await siteTile.first().waitFor({ state: "visible" });

    // Choosing it places the existing photo's own address on the post, with no
    // upload.
    await siteTile.first().click();
    await dialog.getByRole("button", { name: "Use this photo" }).click();
    await dialog.waitFor({ state: "hidden" });
    const preview = composer.locator(
      ".composer-main-image .change-photo-preview img",
    );
    await preview.first().waitFor({ state: "visible" });
    const previewSrc = await preview.first().getAttribute("src");
    if (previewSrc !== "/foundry-gathering.svg") {
      throw new Error(
        `picker_site_photos_wrong_preview:${JSON.stringify(previewSrc)}`,
      );
    }

    // The inline body picker lists the same site photos, not only uploads: open
    // the body "Add photo" picker and confirm the built-in tile is offered.
    await composer.getByRole("button", { name: "Add photo" }).click();
    const inlineDialog = page.locator("dialog.media-picker[open]");
    await inlineDialog.waitFor({ state: "visible" });
    await inlineDialog
      .locator(".media-gallery-tile-site")
      .filter({ hasText: "Built-in site image" })
      .first()
      .waitFor({ state: "visible" });
    await inlineDialog.getByRole("button", { name: "Close" }).click();
    await inlineDialog.waitFor({ state: "hidden" });

    process.stdout.write(
      `Picker site photos browser acceptance passed at ${origin}: gave the ` +
        `site a built-in photo, then listed it as a "Built-in site image" tile ` +
        `in the shared picker and chose it onto a post without uploading, ` +
        `placing /foundry-gathering.svg.\n`,
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
