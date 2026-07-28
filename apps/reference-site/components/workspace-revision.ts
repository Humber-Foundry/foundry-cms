import type { ContentRevision } from "@foundry/application";

export function newestContentRevision(
  current: ContentRevision,
  incoming: ContentRevision,
) {
  return current.revision >= incoming.revision ? current : incoming;
}
