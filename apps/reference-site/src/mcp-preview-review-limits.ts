/**
 * Limits shared by the review screen, the review route and the MCP read.
 *
 * They live apart from `mcp-preview-review-runtime.ts` because that file is
 * server-only and the review screen's controls run in the browser.
 */

/** The longest reason a person may type when they ask for changes. */
export const previewChangeReasonLimit = 1000;
