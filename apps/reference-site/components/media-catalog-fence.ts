export type MediaCatalogFence = Readonly<{
  snapshot(): number;
  beginMutation(): void;
  endMutation(): void;
  isCurrent(snapshot: number): boolean;
}>;

export function createMediaCatalogFence(): MediaCatalogFence {
  let generation = 0;
  return {
    snapshot: () => generation,
    beginMutation: () => {
      generation += 1;
    },
    endMutation: () => {
      generation += 1;
    },
    isCurrent: (snapshot) => snapshot === generation,
  };
}
