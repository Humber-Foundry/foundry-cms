# ADR-0009: Preset looks are derived, and the token contract owns the palette

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

The Design destination offered four tokens with two values each, shown as
dropdowns listing the raw stored value. An owner could read "Heading
typography: editorial / modern" and had no way to learn what either one did
without publishing and looking at the site.

[Issue #116](https://github.com/Humber-Foundry/foundry-cms/issues/116) asks
for two things. First, a small set of well-designed starting looks, each a
coherent combination of type, colour and spacing. Second, granular controls
to adjust the chosen look, with a live preview of the real site, so every
control shows its effect before it is committed.

Three constraints already fixed by earlier decisions still hold.

- The Site Definition stores only registered option values. No colour, font
  stack or length ever enters content, so a compromised editor or MCP agent
  cannot inject CSS. This is why the site is rendered with data attributes and
  the stylesheet holds the values.
  See `packages/site-definition/src/design-tokens.ts`.
- Design changes are ordinary content changes. They ride the draft, preview
  and publish pipeline in
  [ADR-0004](ADR-0004-draft-preview-publish-pipeline.md) with no separate path.
- A stored Site Definition is versioned, and an older one is projected forward
  rather than rejected.

Two questions had to be answered before the module could be built.

1. Where does a preset live? If a preset name is stored next to the token
   values, the two can disagree. An owner picks "Gallery", changes the accent
   colour, and the record still says "Gallery" while the site no longer looks
   like it.
2. Where do the actual colours, font stacks and sizes live? The controls must
   draw a real swatch and a real font sample, so the editor needs the concrete
   values. The site needs them as CSS. Two copies can drift apart, and a
   control that draws the wrong colour is worse than no control.

## Decision

### A preset look is derived, never stored

A preset is a name, a description and one complete set of token values.
Choosing a preset writes every one of its token values into the draft as a
single undoable edit. Nothing else is recorded.

Which preset is selected is worked out by comparing the draft's design with
each preset's design, in `matchDesignPreset`. An exact match names that
preset. Anything else is reported as a design that matches no preset.

The Site Definition schema therefore gains no preset field, and no invariant
has to be maintained between a preset name and the values it stands for. Fine
tuning one value simply stops the comparison matching, which is the truth the
owner should see.

### The token contract owns the palette; the stylesheet owns the CSS; a test binds them

Each registered option carries a `preview`: the exact font stack for a font
option, the exact accent and its deep shade for an accent option, the five
exact page tones for a page-tone option, or a relative size for a spacing or
width option. The Design module draws its samples from these values, so a
swatch is painted with the same colour the page will use.

The stylesheet keeps its own declarations, because that is what the browser
reads and because keeping colours out of content is the point of the whole
design.

`apps/reference-site/src/design-stylesheet.test.ts` reads both and fails if
they disagree: every registered option must have a rule, every font and colour
must match exactly, and the spacing and width options must be ordered on the
page the same way their previews claim.

`packages/site-definition/src/design-presets.test.ts` checks the palette
itself. Every accent colour and its deep shade must reach WCAG AA against
white button text, every page tone must reach WCAG AAA for body text, and
every accent must reach AA on every page tone. An unreadable combination
cannot be offered, because the contract will not build.

### Site Definition 1.5.0 adds body font and page tone

The vocabulary grows from four tokens to six: heading font, body text font,
accent colour, page tone, space between sections, and content width. Options
per token grow from two to between three and six.

The schema moves to 1.5.0, on top of the 1.4.0 SEO and sharing field set
([ADR-0008](ADR-0008-seo-metadata-shared-field-set.md)).
`projectSiteDefinitionSchema` runs the 1.4.0 sharing-field step first, then
fills `design.typography.body` with `modern` and `design.colour.neutral` with
`warm` for every stored 1.0.0 to 1.4.0 definition. Those are the sans body
font and the warm paper the stylesheet already used, so a projected site looks
exactly as it did before the upgrade.

### The live preview renders the working draft directly

The Design destination renders `SiteRenderer` against the same working
definition the controls write, laid out at a fixed desktop width and scaled
down to the column. It is not an iframe and not a saved revision: it is the
draft in the editor's own memory, so a click and its effect appear together.

The preview is marked `inert` and `aria-hidden`. It is a picture of the site,
not a second copy to read or operate. The words that carry the meaning are the
option labels and descriptions, and the toolbar's Preview button still opens
the exact saved revision as a real page.

## Consequences

- A preset name shown to an owner can never disagree with the site, because it
  is computed from the site's own values.
- Two presets may not share one set of token values, or the derived match
  would be ambiguous. A test enforces that they are distinct.
- Choosing a preset is one entry in the editor's undo history, which needed a
  new `editMany` action in the content editor reducer. The batch is applied in
  full or not at all, so a half-applied look is not reachable.
- Adding a token means changing the contract, the stylesheet, the schema and
  the projection together. The stylesheet test makes a partial change fail
  rather than ship a control that lies.
- Every offered colour combination is legible, and stays legible, without a
  designer re-checking by hand.
- The preview is a guide, not an exact copy, and says so on screen. Two limits
  follow from rendering the site inside the dashboard page rather than in an
  iframe. Its media queries read the browser viewport, not the preview column,
  so it always shows the desktop layout and never the phone one. Its `vw`
  lengths — the page gutter, the section padding and the hero heading — also
  resolve against the browser viewport, so those sizes sit a little out of
  proportion to the preview's own width. Every design change is still visible
  and correct in kind; only the exact proportions differ. The toolbar's
  Preview button opens the exact saved revision as a real page, and that is
  the accurate check on any device.
- The preview lays the site out at 1560px, wider than the widest content-width
  option at 92rem. A narrower preview box would clamp the wide option to the
  box and make it look identical to standard, so a real control would appear
  to do nothing.

## What this decision does not cover

Three things were considered and deliberately left out. They are written here
so a later reader does not mistake them for oversights.

- **A section style has no sample on its card.** Every token option carries a
  preview the card draws — a font, a colour pair, a page tone or a bar at the
  option's relative size. A section style is an arrangement, so it has no
  single colour, font or size to sample. Its card carries the plain label and
  description instead, and the live preview shows the arrangement the moment
  it is chosen, which is before anything is published.
- **Four registered page components keep a fixed palette.** The image-and-copy
  story, photo band, connector cards and invitation bands in
  `apps/reference-site/app/public.css` paint themselves with fixed colours and
  hard offset shadows. That palette is their design, not a missed token: it is
  what makes them read as a distinct band. Their headings do follow the
  heading-font token. A page built mainly from those bands therefore changes
  less than the rest of the site when a page tone or accent changes. Bringing
  them under the tokens would be a redesign of those components and belongs to
  its own ticket.
- **The closing section's accent style is still stored as `moss`.** The
  registered value predates the accent token; the owner reads its label,
  "Accent colour", and the panel now takes whichever accent the site uses. The
  stored name is stale, but renaming it changes a published artifact and would
  need a second reconstruction step in the production content-hash check in
  `apps/reference-site/scripts/assert-exact-production-content.mjs`. That risk
  belongs to a ticket of its own, not to this one.

## Alternatives considered

- **Store the chosen preset id alongside the token values** — rejected. It
  creates a second source of truth for what the site looks like, and the two
  disagree the moment the owner fine-tunes anything. Every screen would then
  need a rule for which one wins.
- **Store a preset id instead of token values, and resolve it at render** —
  rejected. Fine tuning would then require an override layer, published
  content would no longer state its own design, and changing a preset's
  definition in a later release would silently change every site using it.
- **Put the colours and font stacks only in CSS and let the editor read them
  from the document** — rejected. The editor would have to render a hidden
  element per option and read computed styles, which is slow, fragile in
  tests, and gives nothing to check contrast against at build time.
- **Put the colours only in TypeScript and write them into the page as inline
  styles** — rejected. It puts raw CSS values back into rendered markup and
  loses the guarantee that content can only ever name a registered option.
- **Load web fonts to widen the type choices** — rejected for this change. It
  adds a network dependency, a licensing question and a loading strategy to a
  module that is already large. The four options are system font stacks that
  are visibly different from each other and cost nothing to load.
- **Preview the site in an iframe so its media queries match the preview
  width** — rejected for this change. The editor already has an iframe canvas
  for Pages with its own style-synchronising code, and reusing it here would
  couple the Design module to the page-composition editor. The desktop preview
  plus the existing exact preview covers the need.
