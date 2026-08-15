export function assertReferencePage(html) {
  if (!/<main(?:\s|>)/.test(html) || !html.includes("<h1")) {
    throw new Error("Rendered output does not contain the reference page.");
  }
}
