const token = <const Values extends readonly string[]>(
  label: string,
  values: Values,
) => Object.freeze({ label, values: Object.freeze(values) });

export const designContract = Object.freeze({
  tokens: Object.freeze({
    "typography.heading": token("Heading typography", [
      "editorial",
      "modern",
    ] as const),
    "colour.accent": token("Accent colour", ["moss", "clay"] as const),
    "spacing.section": token("Section spacing", [
      "relaxed",
      "compact",
    ] as const),
    "layout.contentWidth": token("Content width", [
      "standard",
      "wide",
    ] as const),
  }),
  variants: Object.freeze({
    hero: token("Hero variant", ["editorial", "focused"] as const),
    services: token("Services variant", ["list", "cards"] as const),
    proof: token("Proof variant", ["panel", "plain"] as const),
    callToAction: token("Call to action variant", ["moss", "ink"] as const),
  }),
});

type RegisteredValue<
  Registration extends Readonly<{ values: ReadonlyArray<string> }>,
> = Registration["values"][number];

export type SiteDesign = Readonly<{
  typography: Readonly<{
    heading: RegisteredValue<
      typeof designContract.tokens["typography.heading"]
    >;
  }>;
  colour: Readonly<{
    accent: RegisteredValue<typeof designContract.tokens["colour.accent"]>;
  }>;
  spacing: Readonly<{
    section: RegisteredValue<typeof designContract.tokens["spacing.section"]>;
  }>;
  layout: Readonly<{
    contentWidth: RegisteredValue<
      typeof designContract.tokens["layout.contentWidth"]
    >;
  }>;
}>;

export type HeroVariant = RegisteredValue<
  typeof designContract.variants.hero
>;
export type ServicesVariant = RegisteredValue<
  typeof designContract.variants.services
>;
export type ProofVariant = RegisteredValue<
  typeof designContract.variants.proof
>;
export type CallToActionVariant = RegisteredValue<
  typeof designContract.variants.callToAction
>;

export const defaultSiteDesign = Object.freeze({
  typography: Object.freeze({
    heading: designContract.tokens["typography.heading"].values[0],
  }),
  colour: Object.freeze({
    accent: designContract.tokens["colour.accent"].values[0],
  }),
  spacing: Object.freeze({
    section: designContract.tokens["spacing.section"].values[0],
  }),
  layout: Object.freeze({
    contentWidth: designContract.tokens["layout.contentWidth"].values[0],
  }),
} satisfies SiteDesign);

export function siteDesignAttributes(design: SiteDesign) {
  return {
    "data-typography-heading": design.typography.heading,
    "data-colour-accent": design.colour.accent,
    "data-spacing-section": design.spacing.section,
    "data-layout-content-width": design.layout.contentWidth,
  } as const;
}
