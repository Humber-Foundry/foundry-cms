import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import type { HumanMembership } from "@humber-foundry/application";
import { createSiteId } from "@humber-foundry/site-definition";
import {
  humanMutationResultHeader,
  recordedHumanMutationResult,
} from "../src/human-mutation-protocol";

// The dashboard's own stylesheet, so the layout assertions exercise the real
// grid and spacing rules instead of the browser's unstyled default layout.
import "../app/dash/dashboard.css";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

import {
  AccessSyncRetryControls,
  MemberAccessPanel,
  useHumanAccessMutation,
} from "./member-access-controls";

/**
 * The real Settings page shares one `useHumanAccessMutation` between the
 * Users panel and the Technical detail retry controls through
 * `SettingsPageBody` (a Client Component the server page renders with plain
 * data). This test-only stand-in reproduces that same wiring without the
 * rest of the page, so the tests below exercise the actual shared-state
 * contract.
 */
function TestSettingsScope({
  members,
  csrfToken,
  withRetryControls,
}: {
  members: ReadonlyArray<HumanMembership>;
  csrfToken: string;
  withRetryControls: boolean;
}) {
  const mutation = useHumanAccessMutation({ csrfToken });
  return createElement(
    "div",
    null,
    createElement(MemberAccessPanel, { members, mutation }),
    withRetryControls
      ? createElement(AccessSyncRetryControls, { mutation })
      : null,
  );
}

const siteId = createSiteId("site_reference");

function member(overrides: Partial<HumanMembership> = {}): HumanMembership {
  return {
    id: "membership-owner" as HumanMembership["id"],
    siteId,
    userId: "user-owner" as HumanMembership["userId"],
    email: "owner@example.com",
    identityBinding: {
      issuer: "https://foundry.cloudflareaccess.com",
      subject: "owner-subject",
    },
    role: "owner",
    status: "active",
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

describe("Settings Users panel and its shared access mutation state", () => {
  let root: ReturnType<typeof createRoot> | undefined;

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (root !== undefined) flushSync(() => root!.unmount());
    document.body.replaceChildren();
    await page.viewport(1024, 768);
  });

  function renderScope(
    members: ReadonlyArray<HumanMembership>,
    handleRequest: (init: RequestInit) => Promise<Response> | Response,
    { withRetryControls = true }: { withRetryControls?: boolean } = {},
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
        createElement(TestSettingsScope, {
          members,
          csrfToken: "csrf",
          withRetryControls,
        }),
      );
    });
    return { host };
  }

  it("shows the plain word User, not Member, in the table", async () => {
    const { host } = renderScope([member()], () => Response.json({ ok: true }));

    expect(host.querySelector('[aria-label="Users"]')).not.toBeNull();
    expect(host.textContent).toContain("User");
    expect(host.textContent).not.toContain("Member");
  });

  it("offers the sole active Owner no refusable action, and explains why", async () => {
    const { host } = renderScope([member()], () => Response.json({ ok: true }));

    const row = host.querySelector(".inventory-row:not(.inventory-head)");
    expect(row).not.toBeNull();
    expect(row!.querySelector("button")).toBeNull();
    expect(row!.textContent).toContain(
      "The site must always have one Owner, so make another person an Owner first.",
    );
  });

  it("keeps the usual actions on both rows when there are two active Owners", async () => {
    const { host } = renderScope(
      [
        member({ id: "membership-owner-1" as HumanMembership["id"] }),
        member({
          id: "membership-owner-2" as HumanMembership["id"],
          email: "second-owner@example.com",
        }),
      ],
      () => Response.json({ ok: true }),
    );

    const rows = host.querySelectorAll(".inventory-row:not(.inventory-head)");
    expect(rows).toHaveLength(2);
    for (const row of Array.from(rows)) {
      expect(
        Array.from(row.querySelectorAll("button")).map((button) =>
          button.textContent?.trim(),
        ),
      ).toEqual(["Make Editor", "Suspend", "Revoke"]);
      expect(row.textContent).not.toContain(
        "The site must always have one Owner",
      );
    }
  });

  it("still offers the usual actions on an Editor's row when the sole Owner is also listed", async () => {
    const { host } = renderScope(
      [
        member(),
        member({
          id: "membership-editor" as HumanMembership["id"],
          role: "editor",
          email: "editor@example.com",
        }),
      ],
      () => Response.json({ ok: true }),
    );

    const rows = Array.from(
      host.querySelectorAll(".inventory-row:not(.inventory-head)"),
    );
    const editorRow = rows.find((row) =>
      row.textContent?.includes("editor@example.com"),
    );
    expect(editorRow).toBeDefined();
    expect(
      Array.from(editorRow!.querySelectorAll("button")).map((button) =>
        button.textContent?.trim(),
      ),
    ).toEqual(["Make Owner", "Suspend", "Revoke"]);
  });

  it("gives Owner, Editor, Active, Suspended and Revoked each their own help tip", async () => {
    const { host } = renderScope([member()], () => Response.json({ ok: true }));

    const labels = [
      "What can an Owner do?",
      "What can an Editor do?",
      "What does Active mean?",
      "What does Suspended mean?",
      "What does Revoked mean?",
    ];
    for (const label of labels) {
      expect(
        host.querySelector(`.help-tip-trigger[aria-label="${label}"]`),
      ).not.toBeNull();
    }
  });

  it("asks for confirmation in a dashboard dialog before a role change, never window.confirm", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    let roleChangeCalled = false;
    const { host } = renderScope(
      [member({ role: "editor", email: "editor@example.com" })],
      (init) => {
        const body = JSON.parse(String(init.body));
        if (body.action === "change_role") roleChangeCalled = true;
        return Response.json({ ok: true });
      },
    );

    await userEvent.click(page.getByRole("button", { name: "Make Owner" }));

    const dialog = await waitFor(
      () =>
        host.ownerDocument.querySelector(
          "dialog.revoke-confirm-dialog[open]",
        ) ?? undefined,
    );
    expect(dialog.textContent).toContain("Change this person's role?");
    expect(dialog.textContent).toContain("Make editor@example.com an Owner?");
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(roleChangeCalled).toBe(false);

    await userEvent.click(
      page.getByRole("dialog").getByRole("button", { name: "Confirm" }),
    );
    await waitFor(() => (roleChangeCalled ? true : undefined));
    expect(roleChangeCalled).toBe(true);
  });

  it("cancelling the role change dialog sends nothing", async () => {
    let sendCalled = false;
    const { host } = renderScope([member({ role: "editor" })], () => {
      sendCalled = true;
      return Response.json({ ok: true });
    });

    await userEvent.click(page.getByRole("button", { name: "Make Owner" }));
    await waitFor(
      () =>
        host.ownerDocument.querySelector(
          "dialog.revoke-confirm-dialog[open]",
        ) ?? undefined,
    );
    await userEvent.click(page.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      host.ownerDocument.querySelector("dialog.revoke-confirm-dialog[open]") ===
      null
        ? true
        : undefined,
    );
    expect(sendCalled).toBe(false);
  });

  it("still confirms a Suspend through the dashboard dialog, not window.confirm", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    let statusChangeCalled = false;
    // Not the sole active Owner — an Editor row keeps its Suspend button, so
    // this test still exercises the same dialog it always has (#150: the
    // sole active Owner's row no longer offers Suspend at all).
    renderScope([member({ role: "editor", email: "editor@example.com" })], (init) => {
      const body = JSON.parse(String(init.body));
      if (body.action === "change_status") statusChangeCalled = true;
      return Response.json({ ok: true });
    });

    await userEvent.click(
      page.getByRole("button", { name: "Suspend", exact: true }),
    );

    await waitFor(() =>
      document.querySelector("dialog.revoke-confirm-dialog[open]"),
    );
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(statusChangeCalled).toBe(false);

    await userEvent.click(
      page.getByRole("dialog").getByRole("button", { name: "Confirm" }),
    );
    await waitFor(() => (statusChangeCalled ? true : undefined));
    expect(statusChangeCalled).toBe(true);
  });

  it("shows the plain reason for a refused change instead of a generic sentence", async () => {
    const { host } = renderScope(
      [
        member({ id: "membership-owner-1" as HumanMembership["id"] }),
        member({
          id: "membership-owner-2" as HumanMembership["id"],
          email: "second-owner@example.com",
        }),
      ],
      () =>
        Response.json(
          { error: "not_authorized", reason: "membership_email_ambiguous" },
          {
            status: 403,
            headers: { [humanMutationResultHeader]: recordedHumanMutationResult },
          },
        ),
    );

    await userEvent.click(
      page.getByRole("button", { name: "Suspend", exact: true }).first(),
    );
    await waitFor(() =>
      document.querySelector("dialog.revoke-confirm-dialog[open]"),
    );
    await userEvent.click(
      page.getByRole("dialog").getByRole("button", { name: "Confirm" }),
    );

    await waitFor(() =>
      host.textContent?.includes("already invited") ? true : undefined,
    );
    expect(host.textContent).toContain(
      "That email address is not valid, or is already invited.",
    );
    expect(host.textContent).not.toContain("Access change was not applied.");
  });

  it("shares one mutation state: a failed request's retry button appears in the technical detail controls", async () => {
    const { host } = renderScope([member({ role: "editor" })], () =>
      Promise.reject(new TypeError("network down")),
    );

    await userEvent.click(page.getByRole("button", { name: "Make Owner" }));
    await waitFor(() =>
      document.querySelector("dialog.revoke-confirm-dialog[open]"),
    );
    await userEvent.click(
      page.getByRole("dialog").getByRole("button", { name: "Confirm" }),
    );

    const retryButton = await waitFor(() =>
      Array.from(host.querySelectorAll("button")).find(
        (button) => button.textContent === "Retry access change",
      ),
    );
    expect(retryButton).toBeDefined();
  });

  it("shows no retry controls before any mutation has failed", () => {
    const { host } = renderScope([member()], () => Response.json({ ok: true }));

    expect(host.querySelector(".access-sync-retry-controls")).toBeNull();
  });
});
