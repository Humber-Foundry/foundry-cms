export function assertReferencePage(html) {
  if (!html.includes("<main>") || !html.includes("<h1")) {
    throw new Error("Rendered output does not contain the reference page.");
  }
}
