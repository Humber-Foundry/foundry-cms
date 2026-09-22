# ADR-0040: A page component paints only from design tokens

- **Status:** Accepted
- **Date:** 2026-09-21

## Context

The Design screen tells the owner "Every change shows here straight away". On
2026-09-21 the owner chose the Studio look and the Technical mono heading font
and nothing in the preview panel moved.

The preview was not at fault. It renders the unsaved working draft, and
`SiteRenderer` already puts the draft's design on `.site-canvas` as data
attributes. `globals.css` already turns each attribute into a custom property:
`--design-heading-font`, `--design-body-font`, `--design-accent`,
`--design-accent-deep`, `--design-section-padding`, `--design-content-width`.

The fault was in the page component styles. `apps/reference-site/app/public.css`
wrote its own colours and its own fonts:

- `.story-copy h2` set `color: #212530`, the exact colour the owner watched stay
  put.
- `.handwritten-label` set `font-family: var(--font-serif)`, the site-wide
  serif, so it ignored the heading font token.
- `.photo-band`, `.connector-section` and `.invitation-section` set literal
  band colours, and the connector cards set a literal card colour, frame and
  shadow.

Only a few rules honoured a token. A colour written in a rule cannot follow the
design the owner chose, so the preview panel showed a change that would never
reach the page.

This matters beyond one stylesheet. A client installation hand-ports
`apps/reference-site/foundry/page-components.tsx` and the styles beside it. A
rule written by hand in an installation carries the same fault, and no test in
this repository would ever see it.

## Decision

**A page component may not set a colour, a font family or a content width by
hand. Every such value comes from a design token custom property.**

### 1. The palette a page component may paint with

`globals.css` declares the whole palette on `.site-canvas`. Nothing else is
available to a page component rule:

| Property | What it is |
| --- | --- |
| `--design-heading-font` | The heading font the owner chose |
| `--design-body-font` | The body font the owner chose |
| `--design-mono-font` | The fixed-width font for a small technical detail |
| `--design-accent` | The one strong colour |
| `--design-accent-deep` | The pressed and hovered shade of the accent |
| `--design-accent-ink` | Text and buttons placed on the accent |
| `--design-page` | The page background |
| `--design-card` | A raised surface: a card, a photo mount, an input field |
| `--design-panel` | A tinted block inside the page |
| `--design-heading-ink` | Heading text |
| `--design-body-ink` | Paragraph text |
| `--design-line` | A hairline border |
| `--design-frame` | A heavy drawn frame |
| `--design-shadow` | A drop shadow |
| `--design-overlay` | A panel laid over a photograph |
| `--design-band` | A light full-width colour band |
| `--design-band-strong` | A strong full-width colour band |
| `--design-section-padding` | The space between one band and the next |
| `--design-content-width` | How wide text and pictures run |

Each one follows a registered token option. `--design-card` is new: the page
tone token now carries a `card` tone beside `paper`, `panel`, `ink`, `softInk`
and `line`, with a value for each of the three page tones the owner can choose.
`--design-band` and `--design-band-strong` are mixed from the accent, so a band
follows the accent colour.

A component that needs a second colour uses one of these. It does not invent a
hex value.

### 2. Three tests hold the rule

- `apps/reference-site/src/page-component-stylesheet.test.ts` reads `public.css`
  and fails on a literal colour, a literal font family, or any custom property
  that is not a `--design-*` one, in any declaration that paints.
- `apps/reference-site/components/page-component-design-tokens.browser.test.tsx`
  renders every registered page component twice, under two preset looks that
  differ in every token, and fails when a component paints the same either way.
  It also checks every heading is set in the chosen heading font, and it pins
  the published home page's colours so an unintended change to the public site
  fails.
- `apps/reference-site/src/design-stylesheet.test.ts` keeps the stylesheet and
  the design contract in agreement, and now covers the `card` tone.

### 3. An installation carries the same duty

`docs/architecture/page-component-design-token-contract.md` states the rule for
an installation that hand-ports `page-components.tsx`. An installation
component that ignores the tokens is a defect in that installation.

## Consequences

The public reference site looks the same. `--design-accent-ink` is white, which
is the colour the closing section, the light button and the newsletter button
already used, and the page tone, accent and heading font were already the
values those rules named by hand for the default look. The browser test pins
those exact colours.

The bespoke sections change under a look other than the default, which is the
point: the story background follows the page tone, the two bands follow the
accent, and every heading follows the heading font. Under the default look they
shift from a fixed periwinkle and green to shades mixed from the moss accent.

The attention story had no styles in this repository at all, so its headings
fell back to the body font. It now has token-driven styles here, which is what
the conformance test needs in order to cover it.

The page tone token gained a `card` tone. This is a change to the design
contract, not to the Site Definition: a design still stores only the option
value `warm`, `cool` or `bright`, so no schema change and no migration follow.

A page component that genuinely needs a new colour needs a new entry in the
table above, declared in `globals.css` and derived from a registered token
option. Adding a colour to a component rule instead will fail the stylesheet
test.

## Alternatives considered

**Replace the wrong colours and leave the rule unwritten.** The smallest
change. The next component would bring its own colours back, and an
installation would never learn the rule.

**Register a token for every colour the bespoke sections use, each with its own
owner-facing choice.** Honest about where the colours come from. It would put a
long list of colour pickers on the Design screen, which is the opposite of the
preset looks ADR-0009 chose, and every new field would need a schema step.

**Check the rendered output only, with no stylesheet test.** One test instead of
two. A component can differ between two looks and still hold a hard colour in a
rule the two looks do not reach, so the fault would survive.
