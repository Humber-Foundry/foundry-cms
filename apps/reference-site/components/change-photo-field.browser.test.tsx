import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { ChangePhotoField } from "./change-photo-field";

const harbour = {
  siteId: "site_reference",
  assetId: "asset_harbour",
  objectKey: "media/site_reference/asset_harbour/source",
  sourceHash: "a".repeat(64),
  fileName: "harbour.jpg",
  contentType: "image/jpeg",
  byteLength: 2_411_724,
  width: 1600,
  height: 900,
  createdAt: "2026-08-01T00:00:00.000Z",
  createdBy: "membership-owner",
};

const grant = {
  assets: [harbour],
  occurrences: [],
  accessToken: "signed-media-access",
  accessTokenExpiresAt: Math.floor(Date.now() / 1_000) + 600,
  libraryToken: "signed-media-library",
  libraryTokenExpiresAt: Math.floor(Date.now() / 1_000) + 600,
};

async function waitFor<Value>(read: () => Value | undefined): Promise<Value> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition_not_reached");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("change photo field", () => {
  let root: ReturnType<typeof createRoot> | undefined;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (root !== undefined) flushSync(() => root!.unmount());
    document.body.replaceChildren();
  });

  function renderField(initialValue: string) {
    const changes: string[] = [];
    vi.stubGlobal("fetch", async () => Response.json(grant));
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    flushSync(() => {
      root!.render(
        createElement(ChangePhotoField, {
          label: "Image",
          value: initialValue,
          onChange: (next: string) => changes.push(next),
          media: { csrfToken: "csrf", workspaceId: "workspace_owner" },
        }),
      );
    });
    return { changes, host };
  }

  it("offers a Change photo action instead of a raw address", () => {
    const { host } = renderField("/foundry-workshop.svg");
    expect(
      page.getByRole("button", { name: "Change photo" }).query(),
    ).not.toBeNull();
    // The field is not a raw text input holding the address.
    expect(host.querySelector("input[type=text]")).toBeNull();
    expect(host.querySelector("input[type=url]")).toBeNull();
  });

  it("stores the chosen gallery photo as its media reference and previews it", async () => {
    const { changes, host } = renderField("/foundry-workshop.svg");

    await userEvent.click(page.getByRole("button", { name: "Change photo" }));
    await waitFor(
      () => host.querySelector(".media-gallery-tile") ?? undefined,
    );
    await userEvent.click(page.getByRole("button", { name: "harbour.jpg" }));
    await userEvent.click(page.getByRole("button", { name: "Use this photo" }));

    expect(changes).toEqual(["/api/media/asset_harbour"]);
    const preview = await waitFor(
      () =>
        host.querySelector<HTMLImageElement>(".change-photo-preview img") ??
        undefined,
    );
    expect(preview.getAttribute("src")).toBe(
      "/api/foundry-cms/media?assetId=asset_harbour&libraryToken=signed-media-library&variant=thumbnail",
    );
  });
});
