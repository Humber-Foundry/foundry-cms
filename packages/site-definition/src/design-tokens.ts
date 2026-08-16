/**
 * The design vocabulary a site owner may change.
 *
 * A token is one design decision, such as the heading font. Each token offers
 * a fixed list of options. The Site Definition stores only an option's stable
 * value, never a colour, font stack or length, so no editor can put raw CSS
 * into a published page.
 *
 * Every option also carries what the Design module needs to show the owner
 * what it does before they choose it: a plain label, a plain description, and
 * a preview describing the option in concrete terms. The site's own stylesheet
 * holds the matching CSS. `apps/reference-site/src/design-stylesheet.test.ts`
 * checks that the stylesheet and this contract still agree.
 */

/** What the Design module draws so an option shows its own effect. */
export type DesignOptionPreview =
  | Readonly<{ kind: "font"; fontFamily: string }>
  /** `deepColour` is the pressed and hovered shade of the same accent. */
  | Readonly<{ kind: "accent"; colour: string; deepColour: string }>
  | Readonly<{
      kind: "neutral";
      paper: string;
      panel: string;
      ink: string;
      softInk: string;
      line: string;
    }>
  /** A relative size from 0 to 1, drawn as a bar. */
  | Readonly<{ kind: "scale"; ratio: number }>;

export type DesignOption = Readonly<{
  value: string;
  label: string;
  description: string;
  preview: DesignOptionPreview;
}>;

export type DesignTokenRegistration = Readonly<{
  label: string;
  help: string;
  default: string;
  options: ReadonlyArray<DesignOption>;
  /** The registered values, in the same order as `options`. */
  values: ReadonlyArray<string>;
}>;

export type ComponentVariantRegistration = Readonly<{
  label: string;
  help: string;
  options: ReadonlyArray<Readonly<{
    value: string;
    label: string;
    description: string;
  }>>;
  values: ReadonlyArray<string>;
}>;

const fontStacks = Object.freeze({
  editorial: 'Charter, "Source Serif 4", Georgia, serif',
  modern: '"Avenir Next", Avenir, "Helvetica Neue", sans-serif',
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  technical: '"IBM Plex Mono", "Source Code Pro", ui-monospace, monospace',
});

/**
 * Every helper keeps the literal option value in the type. `SiteDesign` is
 * built from those literals, so an unregistered value cannot be assigned to a
 * design anywhere in the product.
 */
const fontOption = <const Value extends keyof typeof fontStacks>(
  value: Value,
  label: string,
  description: string,
) =>
  Object.freeze({
    value,
    label,
    description,
    preview: Object.freeze({
      kind: "font" as const,
      fontFamily: fontStacks[value],
    }),
  });

const accentOption = <const Value extends string>(
  value: Value,
  label: string,
  description: string,
  colour: string,
  deepColour: string,
) =>
  Object.freeze({
    value,
    label,
    description,
    preview: Object.freeze({ kind: "accent" as const, colour, deepColour }),
  });

const neutralOption = <const Value extends string>(
  value: Value,
  label: string,
  description: string,
  tones: Readonly<{
    paper: string;
    panel: string;
    ink: string;
    softInk: string;
    line: string;
  }>,
) =>
  Object.freeze({
    value,
    label,
    description,
    preview: Object.freeze({ kind: "neutral" as const, ...tones }),
  });

const scaleOption = <const Value extends string>(
  value: Value,
  label: string,
  description: string,
  ratio: number,
) =>
  Object.freeze({
    value,
    label,
    description,
    preview: Object.freeze({ kind: "scale" as const, ratio }),
  });

type OptionValues<Options extends ReadonlyArray<{ value: string }>> = {
  readonly [Index in keyof Options]: Options[Index]["value"];
};

function registerToken<const Options extends ReadonlyArray<DesignOption>>(
  label: string,
  help: string,
  defaultValue: Options[number]["value"],
  options: Options,
) {
  return Object.freeze({
    label,
    help,
    default: defaultValue,
    options: Object.freeze(options),
    values: Object.freeze(
      options.map((option) => option.value),
    ) as OptionValues<Options>,
  });
}

function registerVariant<
  const Options extends ReadonlyArray<
    Readonly<{ value: string; label: string; description: string }>
  >,
>(label: string, help: string, options: Options) {
  return Object.freeze({
    label,
    help,
    options: Object.freeze(options),
    values: Object.freeze(
      options.map((option) => option.value),
    ) as OptionValues<Options>,
  });
}

export const designContract = Object.freeze({
  tokens: Object.freeze({
    "typography.heading": registerToken(
      "Heading font",
      "The font used for every heading and large title on the site.",
      "editorial",
      [
        fontOption(
          "editorial",
          "Editorial serif",
          "A book serif with fine detail. Reads as considered and established.",
        ),
        fontOption(
          "modern",
          "Modern sans",
          "An even, rounded sans. Reads as current and approachable.",
        ),
        fontOption(
          "system",
          "Interface sans",
          "The reader's own device font. Reads as plain and familiar.",
        ),
        fontOption(
          "technical",
          "Technical mono",
          "A fixed-width font with visible letter spacing. Reads as precise.",
        ),
      ],
    ),
    "typography.body": registerToken(
      "Body text font",
      "The font used for paragraphs, lists and everything that is not a heading.",
      "modern",
      [
        fontOption(
          "modern",
          "Modern sans",
          "An even, rounded sans that stays clear at small sizes.",
        ),
        fontOption(
          "editorial",
          "Editorial serif",
          "A book serif for long paragraphs. Slower and warmer to read.",
        ),
        fontOption(
          "system",
          "Interface sans",
          "The reader's own device font. Loads instantly on every device.",
        ),
      ],
    ),
    "colour.accent": registerToken(
      "Accent colour",
      "The one strong colour: buttons, links on hover, and the closing panel.",
      "moss",
      [
        accentOption(
          "moss",
          "Moss green",
          "A deep forest green. Calm, outdoor, established.",
          "#1e5c43",
          "#154633",
        ),
        accentOption(
          "clay",
          "Clay red",
          "A burnt terracotta. Warm, hand-made, grounded.",
          "#9a4f36",
          "#753824",
        ),
        accentOption(
          "harbour",
          "Harbour blue",
          "A deep sea blue. Steady, professional, cool.",
          "#1f4f79",
          "#163a59",
        ),
        accentOption(
          "indigo",
          "Indigo violet",
          "A dark violet blue. Formal with a modern edge.",
          "#3b3f83",
          "#2b2e62",
        ),
        accentOption(
          "plum",
          "Plum purple",
          "A deep red purple. Rich and a little unexpected.",
          "#6b3563",
          "#4e2749",
        ),
        accentOption(
          "graphite",
          "Graphite grey",
          "A near-black grey. Lets photographs carry all the colour.",
          "#3a4750",
          "#29333a",
        ),
      ],
    ),
    "colour.neutral": registerToken(
      "Page tone",
      "The background and text colours behind everything else on the page.",
      "warm",
      [
        neutralOption(
          "warm",
          "Warm paper",
          "An off-white with a cream cast, like uncoated paper.",
          {
            paper: "#f5f3ed",
            panel: "#e9e1cf",
            ink: "#17201d",
            softInk: "#4c5853",
            line: "#d7d8d0",
          },
        ),
        neutralOption(
          "cool",
          "Cool grey",
          "A pale blue-grey background. Crisp and businesslike.",
          {
            paper: "#eef1f4",
            panel: "#dde5ec",
            ink: "#16202a",
            softInk: "#48555f",
            line: "#d2d9df",
          },
        ),
        neutralOption(
          "bright",
          "Bright white",
          "A plain white page. Puts every photograph and colour forward.",
          {
            paper: "#ffffff",
            panel: "#f1f2f4",
            ink: "#14171a",
            softInk: "#4b5157",
            line: "#e2e5e8",
          },
        ),
      ],
    ),
    "spacing.section": registerToken(
      "Space between sections",
      "How much empty space separates one band of the page from the next.",
      "relaxed",
      [
        scaleOption(
          "airy",
          "Airy",
          "Large gaps. Each section reads as its own page.",
          1,
        ),
        scaleOption(
          "relaxed",
          "Relaxed",
          "Generous gaps with the whole page still in view.",
          0.71,
        ),
        scaleOption(
          "compact",
          "Compact",
          "Small gaps. More of the page fits on one screen.",
          0.36,
        ),
      ],
    ),
    "layout.contentWidth": registerToken(
      "Content width",
      "How wide the text and pictures run on a large screen.",
      "standard",
      [
        scaleOption(
          "narrow",
          "Narrow",
          "Short lines that are quick to read. Leaves wide side margins.",
          0.61,
        ),
        scaleOption(
          "standard",
          "Standard",
          "The usual width. Balances reading comfort against picture size.",
          0.85,
        ),
        scaleOption(
          "wide",
          "Wide",
          "Fills a large screen. Best when photographs matter most.",
          1,
        ),
      ],
    ),
  }),
  variants: Object.freeze({
    hero: registerVariant(
      "Opening section",
      "How the first thing a visitor sees is arranged.",
      [
        {
          value: "editorial",
          label: "Left aligned",
          description: "Title and buttons sit against the left margin.",
        },
        {
          value: "focused",
          label: "Centred",
          description: "Title and buttons are centred with a shorter title.",
        },
      ],
    ),
    services: registerVariant(
      "Services section",
      "How the numbered list of what you offer is arranged.",
      [
        {
          value: "list",
          label: "Stacked rows",
          description: "One item per row, separated by fine rules.",
        },
        {
          value: "cards",
          label: "Three cards",
          description: "Items sit side by side in bordered cards.",
        },
      ],
    ),
    proof: registerVariant(
      "Quote and numbers section",
      "How the customer quote and the numbers beside it are framed.",
      [
        {
          value: "panel",
          label: "Tinted panel",
          description: "The quote sits on a block of background colour.",
        },
        {
          value: "plain",
          label: "No panel",
          description: "The quote sits on the page with no background block.",
        },
      ],
    ),
    callToAction: registerVariant(
      "Closing section",
      "The colour of the panel that asks the visitor to get in touch.",
      [
        {
          value: "moss",
          label: "Accent colour",
          description: "The panel uses a deep shade of your accent colour.",
        },
        {
          value: "ink",
          label: "Near black",
          description: "The panel uses the page's darkest text colour.",
        },
      ],
    ),
  }),
});

export type DesignTokenKey = keyof typeof designContract.tokens;

/** The Site Definition field path that stores one token. */
export function designTokenFieldPath(key: DesignTokenKey): string {
  return `design.${key}`;
}

/**
 * The Site Definition field path that stores one section's style. A section
 * style belongs to that section rather than to the whole site, so it is keyed
 * by the section's own id.
 */
export function sectionVariantFieldPath(sectionId: string): string {
  return `${sectionId}.variant`;
}

type RegisteredValue<
  Registration extends Readonly<{ values: ReadonlyArray<string> }>,
> = Registration["values"][number];

export type SiteDesign = Readonly<{
  typography: Readonly<{
    heading: RegisteredValue<
      typeof designContract.tokens["typography.heading"]
    >;
    body: RegisteredValue<typeof designContract.tokens["typography.body"]>;
  }>;
  colour: Readonly<{
    accent: RegisteredValue<typeof designContract.tokens["colour.accent"]>;
    neutral: RegisteredValue<typeof designContract.tokens["colour.neutral"]>;
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

/**
 * The concrete colours, fonts and sizes behind a design.
 *
 * An editor that draws a swatch needs the real value, and there must be only
 * one place it can come from. These readers are that place: they look the
 * option up in the contract and fail loudly on a value the contract does not
 * register, so no caller has to carry a fallback colour of its own.
 */
function previewOfKind<Kind extends DesignOptionPreview["kind"]>(
  key: DesignTokenKey,
  value: string,
  kind: Kind,
): Extract<DesignOptionPreview, { kind: Kind }> {
  const option = designContract.tokens[key].options.find(
    (candidate) => candidate.value === value,
  );
  if (option === undefined) {
    throw new TypeError(`design_option_unregistered:${key}:${value}`);
  }
  if (option.preview.kind !== kind) {
    throw new TypeError(`design_option_wrong_kind:${key}:${value}:${kind}`);
  }
  return option.preview as Extract<DesignOptionPreview, { kind: Kind }>;
}

/** The token keys whose options are fonts, so a key and value cannot be mixed. */
type FontTokenKey = "typography.heading" | "typography.body";

export function designFontStack<Key extends FontTokenKey>(
  key: Key,
  value: RegisteredValue<typeof designContract.tokens[Key]>,
): string {
  return previewOfKind(key, value, "font").fontFamily;
}

export function designAccentPalette(
  value: SiteDesign["colour"]["accent"],
): Extract<DesignOptionPreview, { kind: "accent" }> {
  return previewOfKind("colour.accent", value, "accent");
}

export function designNeutralPalette(
  value: SiteDesign["colour"]["neutral"],
): Extract<DesignOptionPreview, { kind: "neutral" }> {
  return previewOfKind("colour.neutral", value, "neutral");
}

export const defaultSiteDesign = Object.freeze({
  typography: Object.freeze({
    heading: designContract.tokens["typography.heading"].default,
    body: designContract.tokens["typography.body"].default,
  }),
  colour: Object.freeze({
    accent: designContract.tokens["colour.accent"].default,
    neutral: designContract.tokens["colour.neutral"].default,
  }),
  spacing: Object.freeze({
    section: designContract.tokens["spacing.section"].default,
  }),
  layout: Object.freeze({
    contentWidth: designContract.tokens["layout.contentWidth"].default,
  }),
} satisfies SiteDesign);

/**
 * A token key such as `colour.accent` names a group and a field inside a
 * design. Splitting it is the one place the walk from key to field is written,
 * so the reader and the writer below cannot disagree about where a token
 * lives.
 */
function designTokenSlot(
  design: SiteDesign,
  key: DesignTokenKey,
): Readonly<{ group: Record<string, string>; name: string }> {
  const [group, name] = key.split(".") as [keyof SiteDesign, string];
  return {
    group: design[group] as unknown as Record<string, string>,
    name,
  };
}

/** Reads one token's value out of a design by its contract key. */
export function designTokenValue(
  design: SiteDesign,
  key: DesignTokenKey,
): string {
  const slot = designTokenSlot(design, key);
  return slot.group[slot.name]!;
}

/**
 * Writes one token's value into a mutable draft design by its contract key.
 * The caller checks the value is registered; this only puts it in the right
 * place.
 */
export function setDesignTokenValue(
  design: SiteDesign,
  key: DesignTokenKey,
  value: string,
): void {
  const slot = designTokenSlot(design, key);
  slot.group[slot.name] = value;
}

/**
 * The HTML attribute that carries one token onto the rendered site, and that
 * the stylesheet selects on. `layout.contentWidth` becomes
 * `data-layout-content-width`.
 */
export function designTokenAttributeName(key: DesignTokenKey): string {
  return `data-${key
    .replace(".", "-")
    .replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`;
}

export const designTokenKeys = Object.freeze(
  Object.keys(designContract.tokens) as DesignTokenKey[],
);

export function siteDesignAttributes(
  design: SiteDesign,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    designTokenKeys.map((key) => [
      designTokenAttributeName(key),
      designTokenValue(design, key),
    ]),
  );
}
