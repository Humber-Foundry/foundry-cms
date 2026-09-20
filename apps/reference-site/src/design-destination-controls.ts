import {
  designContract,
  designTokenFieldPath,
  designTokenValue,
  pageFieldPath,
  sectionVariantFieldPath,
  type DesignOptionPreview,
  type DesignTokenKey,
  type SiteDefinition,
  type SitePage,
} from "@humber-foundry/site-definition";

/**
 * What the Design destination puts on screen, worked out from the design
 * contract and the draft. Keeping this out of the component means the list of
 * controls, their order and their option lists can be tested without a
 * browser, and a token registered in the contract appears in the Design
 * destination with no further wiring.
 */
export type DesignControlOption = Readonly<{
  value: string;
  label: string;
  description: string;
  /** Absent for a section style, which has no colour, font or size of its own. */
  preview?: DesignOptionPreview;
}>;

export type DesignControl = Readonly<{
  /** The Site Definition field path this control writes. */
  path: string;
  label: string;
  help: string;
  value: string;
  options: ReadonlyArray<DesignControlOption>;
}>;

export type DesignControlGroup = Readonly<{
  title: string;
  /** One plain sentence saying what the whole group changes. */
  help: string;
  controls: ReadonlyArray<DesignControl>;
}>;

const tokenGroups: ReadonlyArray<
  Readonly<{ title: string; help: string; tokens: ReadonlyArray<DesignTokenKey> }>
> = [
  {
    title: "Type",
    help: "The two fonts the site uses.",
    tokens: ["typography.heading", "typography.body"],
  },
  {
    title: "Colour",
    help: "The one strong colour, and the paper it sits on.",
    tokens: ["colour.accent", "colour.neutral"],
  },
  {
    title: "Space and width",
    help: "How much room the page gives its content.",
    tokens: ["spacing.section", "layout.contentWidth"],
  },
];

function tokenControl(
  definition: SiteDefinition,
  key: DesignTokenKey,
): DesignControl {
  const token = designContract.tokens[key];
  return {
    path: designTokenFieldPath(key),
    label: token.label,
    help: token.help,
    value: designTokenValue(definition.design, key),
    options: token.options.map((option) => ({
      value: option.value,
      label: option.label,
      description: option.description,
      preview: option.preview,
    })),
  };
}

function sectionStyleControls(
  page: SitePage,
): ReadonlyArray<DesignControl> {
  // The styles listed are those of the page the editor has open. The path is
  // built through `pageFieldPath`, so the list follows the one field path rule
  // on every page.
  return page.sections.flatMap((section) => {
    if (section.type === "registered") {
      return [];
    }
    const variant = designContract.variants[section.type];
    return [
      {
        path: pageFieldPath(page, sectionVariantFieldPath(section.id)),
        label: variant.label,
        help: variant.help,
        value: section.variant,
        options: variant.options.map((option) => ({
          value: option.value,
          label: option.label,
          description: option.description,
        })),
      },
    ];
  });
}

/**
 * How many columns to lay one control's options out in. A grid must fill every
 * row it starts, so the count is chosen to divide the number of options
 * exactly. Anything that does not divide falls back to a single column, which
 * reads as a list rather than a broken grid.
 */
export function optionColumns(optionCount: number): number {
  for (const columns of [3, 2]) {
    if (optionCount % columns === 0) {
      return columns;
    }
  }
  return 1;
}

/**
 * The controls the Design destination shows. The type, colour and space
 * controls belong to the whole site; the section styles belong to `page`.
 */
export function designControlGroups(
  definition: SiteDefinition,
  page: SitePage,
): ReadonlyArray<DesignControlGroup> {
  const sectionStyles = sectionStyleControls(page);
  return [
    ...tokenGroups.map((group) => ({
      title: group.title,
      help: group.help,
      controls: group.tokens.map((key) => tokenControl(definition, key)),
    })),
    ...(sectionStyles.length === 0
      ? []
      : [
          {
            title: "Section styles",
            help: "How each band of the page is arranged.",
            controls: sectionStyles,
          },
        ]),
  ];
}
