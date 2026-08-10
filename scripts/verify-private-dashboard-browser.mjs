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
    await page.waitForURL(/\/dash\?workspace=workspace_[a-f0-9]{24}$/u);
    await page.getByRole("heading", { name: "Content editor" }).waitFor();
    await waitForEnabled(
      page.getByRole("button", {
        name: "Preview exact saved revision ↗",
      }),
      "private_dashboard_content_editor_not_ready",
    );
    const editorFrame = page.frameLocator(".puck-editor-frame iframe");
    const storyHeading = editorFrame.getByRole("heading", {
      name: "There is useful information in the middle of the mess.",
    });
    await storyHeading.waitFor({ state: "visible" });
    await storyHeading.click();
    const storyTitle = page.locator(".puck-editor-frame").getByRole("textbox", {
      name: "Title",
      exact: true,
    });
    await storyTitle.waitFor({ state: "visible" });
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
    const saveRevision = page.getByRole("button", {
      name: "Save revision",
    });
    if (await saveRevision.isEnabled()) {
      await saveRevision.click({ force: true });
    }
    const saved = await savedResponse;
    if (saved.status() !== 201) {
      throw new Error(
        `private_dashboard_save_failed:${saved.status()}:${await saved.text()}`,
      );
    }
    await page.getByText("Revision 1 · saved", { exact: true }).waitFor();
    const [preview] = await Promise.all([
      context.waitForEvent("page"),
      page.getByRole("button", {
        name: "Preview exact saved revision ↗",
      }).click(),
    ]);
    await preview.waitForURL(/\/__foundry\/preview\/workspace_[a-f0-9]{24}\/1\?/u);
    await preview.getByRole("heading", { name: editedStoryTitle }).waitFor();
    if ((await preview.locator(".story-section").count()) !== 1) {
      throw new Error("private_dashboard_preview_custom_renderer_missing");
    }
    const publicPage = await context.newPage();
    await publicPage.goto(origin);
    await publicPage.getByRole("heading", {
      name: "There is useful information in the middle of the mess.",
    }).waitFor();
    if ((await publicPage.locator(".story-section").count()) !== 1) {
      throw new Error("private_dashboard_public_custom_renderer_missing");
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
    await page.getByRole("heading", { name: "Blog posts" }).waitFor();
    const blogTitle = page.locator('.blog-post-form input[name="title"]');
    await blogTitle.waitFor();
    if (!(await blogTitle.isEnabled())) {
      throw new Error("private_dashboard_blog_controls_disabled");
    }
    const createPost = page.getByRole("button", {
      name: "Create post revision",
    });
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
