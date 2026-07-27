import {
  applySiteDefinitionEdits,
  type SiteDefinition,
  type SiteDefinitionEdit,
} from "@foundry/site-definition";

export type ContentRevisionInputs = Readonly<{
  contentHash: string;
  schemaVersion: SiteDefinition["schemaVersion"];
  rendererVersion: string;
  productionBase: string;
}>;

export type ContentRevision = Readonly<{
  revision: number;
  definition: SiteDefinition;
  inputs: ContentRevisionInputs;
  createdAt: string;
  createdBy: string;
}>;

export type SaveContentRevisionCommand = Readonly<{
  actorId: string;
  baseRevision: number;
  edits: ReadonlyArray<SiteDefinitionEdit>;
  idempotencyKey: string;
}>;

type PersistContentRevisionCommand = Readonly<{
  baseRevision: number;
  idempotencyKey: string;
  requestHash: string;
  revision: ContentRevision;
}>;

export type ContentRevisionStore = Readonly<{
  initialize(initialRevision: ContentRevision): Promise<void>;
  getCurrent(): Promise<ContentRevision>;
  getRevision(revision: number): Promise<ContentRevision | null>;
  persist(command: PersistContentRevisionCommand): Promise<ContentRevision>;
}>;

export class ContentRevisionConflictError extends Error {
  readonly currentRevision: number;

  constructor(currentRevision: number) {
    super("content_revision_conflict");
    this.name = "ContentRevisionConflictError";
    this.currentRevision = currentRevision;
  }
}

export class ContentRevisionIdempotencyError extends Error {
  constructor() {
    super("content_revision_idempotency_key_conflict");
    this.name = "ContentRevisionIdempotencyError";
  }
}

export class ContentRevisionValidationError extends Error {
  readonly fields: Readonly<Record<string, string>>;

  constructor(fields: Readonly<Record<string, string>>) {
    super("content_revision_validation_failed");
    this.name = "ContentRevisionValidationError";
    this.fields = fields;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function immutableRevision(revision: ContentRevision): ContentRevision {
  return deepFreeze(structuredClone(revision));
}

export function createInMemoryContentRevisionStore(): ContentRevisionStore {
  const revisions = new Map<number, ContentRevision>();
  const receipts = new Map<
    string,
    Readonly<{ requestHash: string; revision: ContentRevision }>
  >();
  let currentRevision = 0;

  return {
    async initialize(initialRevision) {
      if (revisions.size === 0) {
        const immutable = immutableRevision(initialRevision);
        revisions.set(immutable.revision, immutable);
        currentRevision = immutable.revision;
      }
    },
    async getCurrent() {
      return revisions.get(currentRevision)!;
    },
    async getRevision(revision) {
      return revisions.get(revision) ?? null;
    },
    async persist(command) {
      const receipt = receipts.get(command.idempotencyKey);
      if (receipt !== undefined) {
        if (receipt.requestHash !== command.requestHash) {
          throw new ContentRevisionIdempotencyError();
        }
        return receipt.revision;
      }
      if (command.baseRevision !== currentRevision) {
        throw new ContentRevisionConflictError(currentRevision);
      }
      const revision = immutableRevision(command.revision);
      revisions.set(revision.revision, revision);
      currentRevision = revision.revision;
      receipts.set(command.idempotencyKey, {
        requestHash: command.requestHash,
        revision,
      });
      return revision;
    },
  };
}

export function createContentRevisionApplication({
  siteDefinition,
  store,
  rendererVersion,
  productionBase,
  now = () => new Date().toISOString(),
}: {
  siteDefinition: SiteDefinition;
  store: ContentRevisionStore;
  rendererVersion: string;
  productionBase: string;
  now?: () => string;
}) {
  let initialization: Promise<void> | undefined;
  const initialize = () => {
    initialization ??= (async () => {
      const initial = immutableRevision({
        revision: 0,
        definition: siteDefinition,
        inputs: {
          contentHash: await sha256(siteDefinition),
          schemaVersion: siteDefinition.schemaVersion,
          rendererVersion,
          productionBase,
        },
        createdAt: now(),
        createdBy: "published-base",
      });
      await store.initialize(initial);
    })();
    return initialization;
  };

  return Object.freeze({
    queries: Object.freeze({
      async getCurrent() {
        await initialize();
        return store.getCurrent();
      },
      async getRevision(revision: number) {
        await initialize();
        return store.getRevision(revision);
      },
    }),
    commands: Object.freeze({
      async save(command: SaveContentRevisionCommand) {
        await initialize();
        if (!/^[A-Za-z0-9._:-]{16,128}$/.test(command.idempotencyKey)) {
          throw new ContentRevisionValidationError({
            idempotencyKey: "Use a 16–128 character idempotency key.",
          });
        }
        const base = await store.getRevision(command.baseRevision);
        if (base === null) {
          const current = await store.getCurrent();
          throw new ContentRevisionConflictError(current.revision);
        }
        const edited = applySiteDefinitionEdits(base.definition, command.edits);
        if (!edited.ok) {
          throw new ContentRevisionValidationError(edited.errors);
        }
        const requestHash = await sha256({
          actorId: command.actorId,
          baseRevision: command.baseRevision,
          edits: command.edits,
        });
        const nextRevision: ContentRevision = {
          revision: command.baseRevision + 1,
          definition: edited.definition,
          inputs: {
            contentHash: await sha256(edited.definition),
            schemaVersion: edited.definition.schemaVersion,
            rendererVersion,
            productionBase,
          },
          createdAt: now(),
          createdBy: command.actorId,
        };
        return store.persist({
          baseRevision: command.baseRevision,
          idempotencyKey: command.idempotencyKey,
          requestHash,
          revision: nextRevision,
        });
      },
    }),
  });
}
