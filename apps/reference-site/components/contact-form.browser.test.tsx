import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

// The public stylesheet, so the size and spacing assertions below measure the
// real rules rather than the browser's unstyled defaults.
import "../app/globals.css";
import "../app/public.css";

import { ContactForm } from "./contact-form";

const props = {
  formId: "contact",
  title: "Send a message",
  body: "Tell us what you need. Leave your email address and we will write back.",
  actionLabel: "Send message",
  titleId: "section_contact_form_title",
};

const workingStatus = {
  available: true,
  schemaVersion: "1.0.0",
  turnstileAction: "contact",
  turnstileSiteKey: "0xSITEKEY",
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

function field(name: string) {
  return document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[name="${name}"]`,
  );
}

function type(name: string, value: string) {
  const element = field(name)!;
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
    element,
    value,
  );
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("the public contact form", () => {
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
      root!.render(createElement(ContactForm, { ...props, ...extra }));
    });
  }

  /** Answers the status request, and records every send. */
  function answerStatus(
    value: unknown,
    send: (request: Request) => Response = () =>
      new Response(JSON.stringify({ receiptId: "receipt_1" }), {
        status: 201,
      }),
  ) {
    const sends: Request[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input, init) => {
        const request = new Request(input as RequestInfo, init);
        if (request.method === "GET") {
          return new Response(JSON.stringify(value), {
            headers: { "content-type": "application/json" },
          });
        }
        sends.push(request);
        return send(request);
      },
    );
    return sends;
  }

  async function readyForm() {
    return waitFor(() => {
      const found = field("name");
      return found !== null && !found.disabled ? found : undefined;
    });
  }

  function acceptTheCheck() {
    window.turnstile = {
      render: (_element, options) => {
        (options.callback as (token: string) => void)("browser-token");
        return "widget-1";
      },
      reset: vi.fn(),
    };
  }

  it("says the form is not ready, and shows no field", async () => {
    answerStatus({
      available: false,
      schemaVersion: null,
      turnstileAction: null,
      turnstileSiteKey: null,
    });
    render();
    const note = await waitFor(
      () =>
        [...document.querySelectorAll(".contact-form-note")].find(
          (candidate) =>
            candidate.textContent?.includes("not ready yet") === true,
        ) ?? undefined,
    );
    expect(note.textContent).toContain("cannot take your message");
    expect(document.querySelector("input")).toBeNull();
  });

  it("lets nothing be typed before the server says the form works", () => {
    // The status request is left unanswered, so the form stays waiting.
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise(() => {}),
    );
    render();
    expect(field("name")!.disabled).toBe(true);
    expect(field("message")!.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("button")!.disabled).toBe(
      true,
    );
  });

  it("shows the three fields of the contact form once it works", async () => {
    answerStatus(workingStatus);
    render();
    await readyForm();
    expect(field("name")!.type).toBe("text");
    expect(field("email")!.type).toBe("email");
    expect(field("message")!.tagName).toBe("TEXTAREA");
    for (const name of ["name", "email", "message"]) {
      const control = field(name)!;
      expect(
        document.querySelector(`label[for="${control.id}"]`),
      ).not.toBeNull();
    }
    expect(document.querySelector("button")!.textContent).toBe("Send message");
    expect(document.querySelector("h2")!.id).toBe("section_contact_form_title");
  });

  it("asks the check to claim the action the server named", async () => {
    // The server refuses a message whose check reports any other action, so
    // the block must not carry an action name of its own.
    const drawWidget = vi.fn().mockReturnValue("widget-1");
    window.turnstile = { render: drawWidget, reset: vi.fn() };
    answerStatus({ ...workingStatus, turnstileAction: "enquiries" });
    render();
    await readyForm();
    await waitFor(() => (drawWidget.mock.calls.length > 0 ? true : undefined));
    expect(drawWidget.mock.calls[0]![1]).toMatchObject({
      action: "enquiries",
      sitekey: "0xSITEKEY",
      size: "flexible",
    });
  });

  it("sends what the visitor wrote to the form's own address", async () => {
    const sends = answerStatus(workingStatus);
    acceptTheCheck();
    render();
    await readyForm();
    type("name", "Ada");
    type("email", "ada@example.com");
    type("message", "Please call me back.");
    document.querySelector("form")!.requestSubmit();

    const request = await waitFor(() => sends[0]);
    expect(new URL(request.url).pathname).toBe(
      "/api/forms/contact/submissions",
    );
    expect(await request.json()).toMatchObject({
      schemaVersion: "1.0.0",
      fields: {
        name: "Ada",
        email: "ada@example.com",
        message: "Please call me back.",
      },
      turnstileToken: "browser-token",
      honeypot: "",
    });
  });

  it("leaves a blank address out of the message it sends", async () => {
    const sends = answerStatus(workingStatus);
    acceptTheCheck();
    render();
    await readyForm();
    type("name", "Ada");
    type("message", "No address today.");
    document.querySelector("form")!.requestSubmit();

    const request = await waitFor(() => sends[0]);
    const body = (await request.json()) as {
      fields: Record<string, unknown>;
    };
    expect(body.fields).toEqual({ name: "Ada", message: "No address today." });
  });

  it("thanks the visitor and takes the form away once the message is sent", async () => {
    answerStatus(workingStatus);
    acceptTheCheck();
    render();
    await readyForm();
    type("name", "Ada");
    type("message", "Please call me back.");
    document.querySelector("form")!.requestSubmit();

    const note = await waitFor(
      () =>
        [...document.querySelectorAll(".contact-form-note")].find(
          (candidate) => candidate.textContent?.includes("Thank you") === true,
        ) ?? undefined,
    );
    expect(note.getAttribute("role")).toBe("status");
    expect(document.querySelector("form")).toBeNull();
  });

  it("keeps what the visitor wrote when the send fails", async () => {
    answerStatus(
      workingStatus,
      () => new Response(JSON.stringify({ error: "x" }), { status: 400 }),
    );
    acceptTheCheck();
    render();
    await readyForm();
    type("name", "Ada");
    type("message", "Please call me back.");
    document.querySelector("form")!.requestSubmit();

    const note = await waitFor(
      () =>
        [...document.querySelectorAll(".contact-form-note")].find(
          (candidate) =>
            candidate.textContent?.includes("could not send") === true,
        ) ?? undefined,
    );
    expect(note.textContent).toContain("Please try again");
    expect(field("name")!.value).toBe("Ada");
    expect(field("message")!.value).toBe("Please call me back.");
  });

  it("says plainly when the form cannot take messages just now", async () => {
    answerStatus(
      workingStatus,
      () => new Response(JSON.stringify({ error: "x" }), { status: 503 }),
    );
    acceptTheCheck();
    render();
    await readyForm();
    type("name", "Ada");
    type("message", "Please call me back.");
    document.querySelector("form")!.requestSubmit();

    const note = await waitFor(
      () =>
        [...document.querySelectorAll(".contact-form-note")].find(
          (candidate) =>
            candidate.textContent?.includes("cannot take messages") === true,
        ) ?? undefined,
    );
    expect(note.textContent).toContain("try again later");
    expect(field("message")!.value).toBe("Please call me back.");
  });

  it("sends nothing at all on an editing surface", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("{}"));
    render({ previewOnly: true });
    expect(field("name")!.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("button")!.disabled).toBe(
      true,
    );
    document.querySelector("form")!.requestSubmit();
    expect(fetcher).not.toHaveBeenCalled();
    // No automated-traffic widget is drawn on an editing surface either.
    expect(document.querySelector(".contact-form-check")).toBeNull();
  });

  it("gives every control at least 44px of height at 390px", async () => {
    await page.viewport(390, 844);
    answerStatus(workingStatus);
    render();
    await readyForm();
    const button = document.querySelector<HTMLButtonElement>("button")!;
    for (const element of [
      field("name")!,
      field("email")!,
      field("message")!,
      button,
    ]) {
      expect(element.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
  });

  it("keeps the corner radius on every field and the button", async () => {
    answerStatus(workingStatus);
    render();
    await readyForm();
    for (const element of [
      field("name")!,
      field("message")!,
      document.querySelector<HTMLButtonElement>("button")!,
    ]) {
      expect(
        Number.parseFloat(getComputedStyle(element).borderTopLeftRadius),
      ).toBeGreaterThan(0);
    }
  });

  it("keeps at least 8px between one control and the next at 390px", async () => {
    await page.viewport(390, 844);
    answerStatus(workingStatus);
    render();
    await readyForm();
    const order = [
      field("name")!,
      field("email")!,
      field("message")!,
      document.querySelector<HTMLButtonElement>("button")!,
    ];
    for (let index = 1; index < order.length; index += 1) {
      const gap =
        order[index]!.getBoundingClientRect().top -
        order[index - 1]!.getBoundingClientRect().bottom;
      expect(gap).toBeGreaterThanOrEqual(8);
    }
  });

  it("draws itself from the design tokens, so another look changes it", async () => {
    answerStatus(workingStatus);
    render();
    await readyForm();
    const button = document.querySelector<HTMLButtonElement>("button")!;
    const heading = document.querySelector("h2")!;
    const before = {
      button: getComputedStyle(button).backgroundColor,
      heading: getComputedStyle(heading).fontFamily,
    };

    host!.setAttribute("data-colour-accent", "plum");
    host!.setAttribute("data-typography-heading", "technical");

    expect(getComputedStyle(button).backgroundColor).not.toBe(before.button);
    expect(getComputedStyle(heading).fontFamily).not.toBe(before.heading);
  });

  it("fits the page at 1440px without pushing it sideways", async () => {
    await page.viewport(1440, 900);
    answerStatus(workingStatus);
    render();
    await readyForm();
    expect(host!.getBoundingClientRect().width).toBeLessThanOrEqual(1440);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(1440);
  });
});
