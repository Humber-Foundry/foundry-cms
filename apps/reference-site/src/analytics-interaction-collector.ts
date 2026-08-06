import "server-only";

import {
  allowedInteractionKinds,
  isInteractionKind,
  type InteractionKind,
} from "./analytics-engine-source";

/**
 * The same-origin collector for anonymous interaction counts.
 *
 * It accepts an enumerated event kind and a public CMS object ID and nothing
 * else. Request headers, query strings and the request body beyond those two
 * fields are discarded, and no visitor, session or request identifier is
 * written, so an Analytics Engine point cannot describe a person.
 */

export type InteractionPoint = Readonly<{
  kind: InteractionKind;
  subjectId: string;
}>;

export type InteractionRejectionCode =
  | "payload_invalid"
  | "event_kind_not_allowed"
  | "subject_not_public";

export type InteractionCollectionResult =
  | Readonly<{ outcome: "accepted"; point: InteractionPoint }>
  | Readonly<{ outcome: "rejected"; code: InteractionRejectionCode }>;

export type AnalyticsEngineDataset = Readonly<{
  writeDataPoint(point: {
    blobs: ReadonlyArray<string>;
    doubles?: ReadonlyArray<number>;
    indexes?: ReadonlyArray<string>;
  }): void;
}>;

/**
 * Validates one reported interaction against the public objects this site
 * actually publishes. An unknown subject is refused and not counted, which
 * keeps the dataset's cardinality bounded to real CMS objects.
 */
export function collectInteraction({
  payload,
  publicSubjectIds,
}: {
  payload: unknown;
  publicSubjectIds: ReadonlySet<string>;
}): InteractionCollectionResult {
  if (typeof payload !== "object" || payload === null) {
    return { outcome: "rejected", code: "payload_invalid" };
  }
  const fields = payload as Record<string, unknown>;
  const kind = fields.kind;
  const subjectId = fields.subjectId;
  if (typeof kind !== "string" || typeof subjectId !== "string") {
    return { outcome: "rejected", code: "payload_invalid" };
  }
  // These two fields are read. Everything else about the request is dropped.
  if (!isInteractionKind(kind)) {
    return { outcome: "rejected", code: "event_kind_not_allowed" };
  }
  if (!publicSubjectIds.has(subjectId)) {
    return { outcome: "rejected", code: "subject_not_public" };
  }
  return { outcome: "accepted", point: { kind, subjectId } };
}

export function writeInteractionPoint(
  dataset: AnalyticsEngineDataset,
  point: InteractionPoint,
): void {
  dataset.writeDataPoint({
    // blob1 and blob2 are the only columns the rollup query reads.
    blobs: [point.kind, point.subjectId],
    doubles: [1],
  });
}

export function interactionSubjectType(kind: InteractionKind) {
  return allowedInteractionKinds[kind].subjectType;
}
