import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

// The public stylesheet, so the size and spacing assertions below measure the
// real rules rather than the browser's unstyled defaults.
import "../app/globals.css";
import "../app/public.css";

import { NewsletterSignupForm } from "./newsletter-signup-form";

const props = {
  title: "Get the newsletter",
  body: "A short note every month or so about the work and what we learned from it.",
  actionLabel: "Sign up",
  consentNote:
    "We send you the newsletter and nothing else. Unsubscribe from any message.",
  titleId: "section_newsletter_title",
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

describe("the public newsletter signup form", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  let host: HTMLElement | undefined;

  beforeEach(() => {
    vi.restoreAllMocks();
    delete window.turnstile;
  });

  afterEach(() => {
    if (root !== undefined) flushSync(() => root!.unmount());
    document.body.replaceChildren();
    root = undefined;
    host = undefined;
    delete window.turnstile;
  });

  function render(extra: Record<string, unknown> = {}) {
    host = document.createElement("div");
    host.className = "site-canvas";
    document.body.append(host);
    root = createRoot(host);
    flushSync(() => {
      root!.render(createElement(NewsletterSignupForm, { ...props, ...extra }));
    });
  }

  function answerStatus(value: unknown) {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify(value), {
          headers: { "content-type": "application/json" },
        }),
    );
  }

  async function waitForUnavailable() {
    return waitFor(() =>
      [...document.querySelectorAll(".newsletter-signup-note")].find(
        (note) =>
          note.textContent?.includes("Signup is not available yet") === true,
      ) ?? undefined,
    );
  }

  it("says signup is not available, and shows no address field", async () => {
    answerStatus({ available: false, turnstileSiteKey: null });
    render();
    const note = await waitForUnavailable();
    expect(note.textContent).toContain("will not take your address");
    expect(document.querySelector("input")).toBeNull();
  });

  it("lets nothing be typed before the server says signup works", () => {
    // The status request is left unanswered, so the form stays in its waiting
    // state. A field that looks ready but does nothing is worse than one that
    // waits.
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise(() => {}),
    );
    render();
    expect(document.querySelector<HTMLInputElement>("input")!.disabled).toBe(
      true,
    );
    expect(document.querySelector<HTMLButtonElement>("button")!.disabled).toBe(
      true,
    );
  });

  it("shows the address field once the server says signup works", async () => {
    answerStatus({ available: true, turnstileSiteKey: "0xSITEKEY" });
    render();
    const input = await waitFor(
      () => document.querySelector<HTMLInputElement>("input") ?? undefined,
    );
    expect(input.type).toBe("email");
    expect(document.querySelector("label")!.getAttribute("for")).toBe(
      input.id,
    );
    expect(document.querySelector("button")!.textContent).toBe("Sign up");
  });

  it("gives every control at least 44px of height at 390px", async () => {
    await page.viewport(390, 844);
    answerStatus({ available: true, turnstileSiteKey: "0xSITEKEY" });
    render();
    const input = await waitFor(
      () => document.querySelector<HTMLInputElement>("input") ?? undefined,
    );
    const button = document.querySelector<HTMLButtonElement>("button")!;
    expect(input.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  });

  it("keeps its corner radius on the address field and the button", async () => {
    answerStatus({ available: true, turnstileSiteKey: "0xSITEKEY" });
    render();
    const input = await waitFor(
      () => document.querySelector<HTMLInputElement>("input") ?? undefined,
    );
    const button = document.querySelector<HTMLButtonElement>("button")!;
    for (const element of [input, button]) {
      const radius = Number.parseFloat(
        getComputedStyle(element).borderTopLeftRadius,
      );
      expect(radius).toBeGreaterThan(0);
    }
  });

  it("stacks the field and the button on a phone, and keeps them apart", async () => {
    await page.viewport(390, 844);
    answerStatus({ available: true, turnstileSiteKey: "0xSITEKEY" });
    render();
    const input = await waitFor(
      () => document.querySelector<HTMLInputElement>("input") ?? undefined,
    );
    const button = document.querySelector<HTMLButtonElement>("button")!;
    const gap =
      button.getBoundingClientRect().top - input.getBoundingClientRect().bottom;
    expect(gap).toBeGreaterThanOrEqual(8);
  });

  it("asks the verification widget to fill the row's width, not a fixed narrower one", async () => {
    await page.viewport(390, 844);
    answerStatus({ available: true, turnstileSiteKey: "0xSITEKEY" });
    const renderWidget = vi.fn().mockReturnValue("widget-1");
    window.turnstile = { render: renderWidget, reset: vi.fn() };

    render();
    await waitFor(() =>
      renderWidget.mock.calls.length > 0 ? true : undefined,
    );

    const [container, options] = renderWidget.mock.calls[0]!;
    expect(options).toMatchObject({ size: "flexible" });
    const button = document.querySelector<HTMLButtonElement>("button")!;
    expect((container as HTMLElement).getBoundingClientRect().width).toBe(
      button.getBoundingClientRect().width,
    );
  });

  it("puts the field and the button on one line at 1440px", async () => {
    await page.viewport(1440, 900);
    answerStatus({ available: true, turnstileSiteKey: "0xSITEKEY" });
    render();
    const input = await waitFor(
      () => document.querySelector<HTMLInputElement>("input") ?? undefined,
    );
    const button = document.querySelector<HTMLButtonElement>("button")!;
    expect(input.getBoundingClientRect().top).toBeCloseTo(
      button.getBoundingClientRect().top,
      0,
    );
    expect(
      button.getBoundingClientRect().left - input.getBoundingClientRect().right,
    ).toBeGreaterThanOrEqual(8);
  });

  it("carries the section's heading id so the section has a name", async () => {
    answerStatus({ available: true, turnstileSiteKey: "0xSITEKEY" });
    render();
    await waitFor(
      () => document.querySelector<HTMLInputElement>("input") ?? undefined,
    );
    expect(document.querySelector("h2")!.id).toBe("section_newsletter_title");
  });

  it("sends nothing at all on the editor canvas", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("{}"));
    render({ previewOnly: true });
    const input = document.querySelector<HTMLInputElement>("input")!;
    expect(input.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("button")!.disabled).toBe(
      true,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("can be tried again after a refused try", async () => {
    answerStatus({ available: true, turnstileSiteKey: "1x00000000000000000000AA" });
    render();
    const input = await waitFor(() => {
      const found = document.querySelector<HTMLInputElement>("input");
      return found !== null && !found.disabled ? found : undefined;
    });
    const button = document.querySelector<HTMLButtonElement>("button")!;

    // Sending before the automated-traffic check has finished is refused.
    document.querySelector<HTMLFormElement>("form")!.requestSubmit();
    const note = await waitFor(() =>
      [...document.querySelectorAll(".newsletter-signup-note")].find(
        (candidate) =>
          candidate.textContent?.includes("try again") === true,
      ) ?? undefined,
    );
    expect(note.textContent).toContain("try again");

    // After a refusal the person must be able to correct what they typed and
    // send again, rather than press a button that does nothing.
    expect(input.disabled).toBe(false);
    expect(button.disabled).toBe(false);
  });

  it("carries a message for somebody with JavaScript off", async () => {
    // A browser that runs JavaScript never parses the contents of a noscript
    // element, so only its presence can be checked here. The wording is
    // checked against the server-rendered markup in the node test beside this
    // file.
    answerStatus({ available: true, turnstileSiteKey: "0xSITEKEY" });
    render();
    await waitFor(() => document.querySelector("noscript") ?? undefined);
    expect(document.querySelector("noscript")).not.toBeNull();
  });

  it("says signup is not available when the status cannot be read", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    render();
    await waitForUnavailable();
    expect(document.querySelector("input")).toBeNull();
  });

  it("uses only two type sizes in the block", async () => {
    answerStatus({ available: true, turnstileSiteKey: "0xSITEKEY" });
    render();
    await waitFor(
      () => document.querySelector<HTMLInputElement>("input") ?? undefined,
    );
    const sizes = new Set(
      [
        ...document.querySelectorAll<HTMLElement>(
          "h2, p, label, input, button",
        ),
      ].map((element) => getComputedStyle(element).fontSize),
    );
    expect(sizes.size).toBeLessThanOrEqual(2);
  });
});
