/**
 * The one rule for a dashboard address: it carries the workspace the person
 * is editing.
 *
 * Moving between a list and one item never drops the workspace and sends the
 * person back to a different draft. Newsletter (`campaign-links.ts`) and Blog
 * (`blog-links.ts`) both build their addresses through this.
 *
 * This module holds only strings, so a server page and a client component can
 * both read it.
 */
export function withWorkspace(path: string, workspace: string | null): string {
  return workspace === null || workspace === ""
    ? path
    : `${path}?workspace=${encodeURIComponent(workspace)}`;
}
