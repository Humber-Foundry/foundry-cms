/**
 * The automated-traffic check every public form on this site uses.
 *
 * Cloudflare Turnstile is loaded from Cloudflare's own address, once per page,
 * however many forms are on it. The script is added explicitly rather than in
 * the page head, so a page with no form loads nothing.
 *
 * Both public forms — newsletter signup and the contact form — share this
 * module, so the script address and the widget's window contract are written
 * down in one place.
 */

declare global {
  interface Window {
    turnstile?: {
      render(
        element: HTMLElement,
        options: Record<string, unknown>,
      ): string | undefined;
      reset(widgetId?: string): void;
    };
  }
}

const turnstileScript =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export function loadTurnstile(): Promise<void> {
  if (window.turnstile !== undefined) return Promise.resolve();
  const existing = document.querySelector<HTMLScriptElement>(
    `script[src="${turnstileScript}"]`,
  );
  if (existing !== null) {
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("turnstile")));
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = turnstileScript;
    script.async = true;
    script.addEventListener("load", () => resolve());
    script.addEventListener("error", () => reject(new Error("turnstile")));
    document.head.append(script);
  });
}
