export type SiteDesign = Readonly<{
  typography: Readonly<{ heading: "editorial" | "modern" }>;
  colour: Readonly<{ accent: "moss" | "clay" }>;
  spacing: Readonly<{ section: "relaxed" | "compact" }>;
  layout: Readonly<{ contentWidth: "standard" | "wide" }>;
}>;

export type HeroVariant = "editorial" | "focused";
export type ServicesVariant = "list" | "cards";
export type ProofVariant = "panel" | "plain";
export type CallToActionVariant = "moss" | "ink";

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

export function siteDesignAttributes(design: SiteDesign) {
  return {
    "data-typography-heading": design.typography.heading,
    "data-colour-accent": design.colour.accent,
    "data-spacing-section": design.spacing.section,
    "data-layout-content-width": design.layout.contentWidth,
  } as const;
}
