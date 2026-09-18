import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import type { McpConnectionSummary } from "@humber-foundry/application";
import { referenceSiteDefinition } from "@humber-foundry/site-definition";

// The dashboard's own stylesheet, so the layout assertion below exercises the
// real grid rules instead of the browser's unstyled default layout.
import "../app/dash/dashboard.css";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

import { McpConnectionControls } from "./mcp-connection-controls";

function connection(
  overrides: Partial<McpConnectionSummary> = {},
): McpConnectionSummary {
  return {
    connectionId: "11111111-1111-4111-8111-111111111111",
    actorId: "22222222-2222-4222-8222-222222222222",
    clientId: "https://client.example/metadata.json",
    siteId: referenceSiteDefinition.site.id,
    scopes: ["site.read"],
    status: "active",
    createdAt: "2026-07-29T18:00:00.000Z",
    revokedAt: null,
    lastUsedAt: null,
    ...overrides,
  };
}

async function waitFor<Value>(read: () => Value | undefined): Promise<Value> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition_not_reached");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("Owner MCP connection controls, revoke dialog", () => {
  let root: ReturnType<typeof createRoot> | undefined;

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (root !== undefined) flushSync(() => root!.unmount());
    document.body.replaceChildren();
    await page.viewport(1024, 768);
  });

  function renderControls(
    connections: ReadonlyArray<McpConnectionSummary>,
    handleRequest: (init: RequestInit) => Promise<Response> | Response,
  ) {
    vi.stubGlobal(
      "fetch",
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        handleRequest(init ?? {}),
    );
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    flushSync(() => {
      root!.render(
        createElement(McpConnectionControls, {
          connections,
          csrfToken: "csrf",
        }),
      );
    });
    return { host };
  }

  it("asks for confirmation in a dashboard dialog instead of window.confirm", async () => {
    let revokeCalled = false;
    const { host } = renderControls([connection()], () => {
      revokeCalled = true;
      return Response.json({ ok: true });
    });

    await userEvent.click(page.getByRole("button", { name: "Revoke" }));

    const dialog = await waitFor(
      () =>
        host.ownerDocument.querySelector(
          "dialog.revoke-confirm-dialog[open]",
        ) ?? undefined,
    );
    expect(dialog.textContent).toContain("Revoke this connection?");
    expect(dialog.textContent).toContain("client.example");
    // The dialog is real DOM the test can find — not the browser's native
    // confirm(), which vitest/browser cannot drive at all.
    expect(revokeCalled).toBe(false);

    await userEvent.click(page.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      host.ownerDocument.querySelector("dialog.revoke-confirm-dialog[open]") ===
      null
        ? true
        : undefined,
    );
    expect(revokeCalled).toBe(false);
  });

  it("reports success in place after the dialog is confirmed", async () => {
    const { host } = renderControls([connection()], () =>
      Response.json({ ok: true }),
    );

    await userEvent.click(page.getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      host.ownerDocument.querySelector("dialog.revoke-confirm-dialog[open]"),
    );
    await userEvent.click(
      page.getByRole("dialog").getByRole("button", { name: "Revoke" }),
    );

    const status = await waitFor(() => {
      const element = host.querySelector('[role="status"]');
      return element !== null && element.textContent !== ""
        ? element
        : undefined;
    });
    expect(status.textContent).toContain("Connection revoked");
  });

  it("reports failure in place when the revoke request fails", async () => {
    const { host } = renderControls([connection()], () =>
      Response.json({ error: "failed" }, { status: 500 }),
    );

    await userEvent.click(page.getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      host.ownerDocument.querySelector("dialog.revoke-confirm-dialog[open]"),
    );
    await userEvent.click(
      page.getByRole("dialog").getByRole("button", { name: "Revoke" }),
    );

    const status = await waitFor(() => {
      const element = host.querySelector('[role="status"]');
      return element !== null && element.textContent !== ""
        ? element
        : undefined;
    });
    expect(status.textContent).toContain("could not be confirmed as revoked");
  });

  it("holds its layout at 390px with a long client name", async () => {
    await page.viewport(390, 800);
    const { host } = renderControls(
      [
        connection({
          clientId:
            "https://a-very-long-connected-agent-client-identifier-for-layout-testing.example/metadata.json",
        }),
      ],
      () => Response.json({ ok: true }),
    );

    const table = await waitFor(
      () => host.querySelector(".inventory-table") ?? undefined,
    );
    expect(table.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth,
    );
  });
});
