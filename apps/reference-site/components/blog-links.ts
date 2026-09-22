/**
 * The three Blog addresses: the posts list, the writing box for a new post,
 * and one saved post's own screen (#230).
 *
 * Every dashboard link carries the workspace the person is editing, so moving
 * between the list and one post never drops it and sends them back to a
 * different draft.
 *
 * This module holds only strings, so a server page and a client component can
 * both read it.
 */

function withWorkspace(path: string, workspace: string | null): string {
  return workspace === null || workspace === ""
    ? path
    : `${path}?workspace=${encodeURIComponent(workspace)}`;
}

export function blogListHref(workspace: string | null): string {
  return withWorkspace("/dash/blog", workspace);
}

export function newBlogPostHref(workspace: string | null): string {
  return withWorkspace("/dash/blog/new", workspace);
}

export function blogPostHref(
  postId: string,
  workspace: string | null,
): string {
  return withWorkspace(
    `/dash/blog/${encodeURIComponent(postId)}`,
    workspace,
  );
}
