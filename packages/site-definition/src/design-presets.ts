import {
  designTokenFieldPath,
  designTokenKeys,
  designTokenValue,
  type SiteDesign,
} from "./design-tokens";

/**
 * A preset look is one complete, coherent set of design token values with a
 * name the owner recognises. Choosing a preset writes every one of its token
 * values into the draft; nothing else about the preset is stored.
 *
 * The Site Definition therefore has no preset field. Which preset is selected
 * is derived by comparing the draft's design with each preset, so a preset
 * name can never disagree with what the site actually looks like. Fine-tuning
 * one value simply means no preset matches any more.
 * See docs/decisions/ADR-0009-design-presets-and-token-vocabulary.md.
 */
export type DesignPreset = Readonly<{
  id: string;
  name: string;
  description: string;
  design: SiteDesign;
}>;

const preset = (
  id: string,
  name: string,
  description: string,
  design: SiteDesign,
): DesignPreset => Object.freeze({ id, name, description, design });

/**
 * Named rather than positional on purpose. The heading and body fonts share
 * three of their values, and so do several colours, so a transposed pair of
 * positional arguments would typecheck and ship the wrong look.
 */
const design = ({
  heading,
  body,
  accent,
  neutral,
  section,
  contentWidth,
}: Readonly<{
  heading: SiteDesign["typography"]["heading"];
  body: SiteDesign["typography"]["body"];
  accent: SiteDesign["colour"]["accent"];
  neutral: SiteDesign["colour"]["neutral"];
  section: SiteDesign["spacing"]["section"];
  contentWidth: SiteDesign["layout"]["contentWidth"];
}>): SiteDesign =>
  Object.freeze({
    typography: Object.freeze({ heading, body }),
    colour: Object.freeze({ accent, neutral }),
    spacing: Object.freeze({ section }),
    layout: Object.freeze({ contentWidth }),
  });

export const designPresets: ReadonlyArray<DesignPreset> = Object.freeze([
  preset(
    "editorial",
    "Editorial",
    "Serif headings on warm paper with a deep green accent. A settled, printed feel.",
    design({
      heading: "editorial",
      body: "modern",
      accent: "moss",
      neutral: "warm",
      section: "relaxed",
      contentWidth: "standard",
    }),
  ),
  preset(
    "studio",
    "Studio",
    "Clean sans headings on a white page with a blue accent. Plain and current.",
    design({
      heading: "modern",
      body: "modern",
      accent: "harbour",
      neutral: "bright",
      section: "relaxed",
      contentWidth: "standard",
    }),
  ),
  preset(
    "workshop",
    "Workshop",
    "Sans headings on warm paper with a clay accent, packed tight so more fits on screen.",
    design({
      heading: "modern",
      body: "modern",
      accent: "clay",
      neutral: "warm",
      section: "compact",
      contentWidth: "narrow",
    }),
  ),
  preset(
    "gallery",
    "Gallery",
    "Serif headings on a white page, wide and airy so photographs lead.",
    design({
      heading: "editorial",
      body: "editorial",
      accent: "plum",
      neutral: "bright",
      section: "airy",
      contentWidth: "wide",
    }),
  ),
  preset(
    "technical",
    "Technical",
    "Fixed-width headings on cool grey with a graphite accent. Precise and quiet in colour.",
    design({
      heading: "technical",
      body: "system",
      accent: "graphite",
      neutral: "cool",
      section: "compact",
      contentWidth: "wide",
    }),
  ),
  preset(
    "journal",
    "Journal",
    "Serif headings and serif paragraphs on cool grey with an indigo accent. Made for long reading.",
    design({
      heading: "editorial",
      body: "editorial",
      accent: "indigo",
      neutral: "cool",
      section: "airy",
      contentWidth: "narrow",
    }),
  ),
]);

function sameDesign(first: SiteDesign, second: SiteDesign): boolean {
  return designTokenKeys.every(
    (key) => designTokenValue(first, key) === designTokenValue(second, key),
  );
}

/**
 * The preset this design is exactly equal to, or `undefined` once the owner
 * has fine-tuned any value away from every preset.
 */
export function matchDesignPreset(
  currentDesign: SiteDesign,
): DesignPreset | undefined {
  return designPresets.find((candidate) =>
    sameDesign(candidate.design, currentDesign),
  );
}

/**
 * The design field edits that turn `currentDesign` into `nextDesign`. Only the
 * tokens whose value actually changes are listed, so applying a preset the
 * draft already uses leaves the draft alone.
 */
export function designEditsForDesign(
  currentDesign: SiteDesign,
  nextDesign: SiteDesign,
): ReadonlyArray<Readonly<{ path: string; value: string }>> {
  return designTokenKeys
    .filter(
      (key) =>
        designTokenValue(currentDesign, key) !==
        designTokenValue(nextDesign, key),
    )
    .map((key) => ({
      path: designTokenFieldPath(key),
      value: designTokenValue(nextDesign, key),
    }));
}
