# The page component design token contract

This page states one rule for anyone who writes or hand-ports a page component.

**A page component may not set a colour, a font family or a content width by
hand. Every such value comes from a design token custom property.**

The decision behind it is
[ADR-0040](../decisions/ADR-0040-page-components-paint-only-from-design-tokens.md).

## Why the rule exists

The Design screen tells the site owner "Every change shows here straight away".
The preview panel renders the unsaved draft, and `SiteRenderer` puts the draft's
design on `.site-canvas` as data attributes. `apps/reference-site/app/globals.css`
turns each attribute into a custom property.

A rule that writes its own colour cannot follow the design the owner chose. The
preview then shows a look the page will never take, and the screen's promise is
false. That is what happened on 2026-09-21: the owner chose the Studio look and
the Technical mono heading font and the preview panel did not move, because the
page component styles held their own colours and their own serif font.

## The palette

These are the only values a page component rule may paint with. They are
declared on `.site-canvas` in `globals.css`.

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
| `--design-ink` | Heading text, and any dark fill |
| `--design-ink-soft` | Paragraph text and other secondary text |
| `--design-line` | A hairline border |
| `--design-frame` | A heavy drawn frame |
| `--design-shadow` | A drop shadow |
| `--design-overlay` | A panel laid over a photograph |
| `--design-band` | A light full-width colour band |
| `--design-band-strong` | A strong full-width colour band |
| `--design-section-padding` | The space between one band and the next |
| `--design-content-width` | How wide text and pictures run |

`color-mix` on one of these is allowed, because the result still follows the
owner's choice:

```css
.my-section {
  background: color-mix(in srgb, var(--design-accent) 22%, var(--design-card));
}
```

## What to do instead of a hex value

| Instead of | Write |
| --- | --- |
| `color: #212530` on a heading | `color: var(--design-ink)` |
| `color: #343947` on a paragraph | `color: var(--design-ink-soft)` |
| `background: #fffaf0` on a card | `background: var(--design-card)` |
| `background: #8298cd` on a band | `background: var(--design-band)` |
| `background: #17a578` on a strong band | `background: var(--design-band-strong)` |
| `color: #ffffff` on the accent | `color: var(--design-accent-ink)` |
| `border: 2px solid #212530` | `border: 2px solid var(--design-frame)` |
| `box-shadow: … rgba(33, 37, 48, 0.14)` | `box-shadow: … var(--design-shadow)` |
| `font-family: var(--font-serif)` | `font-family: var(--design-heading-font)` |
| `width: 78rem` | `width: min(100%, var(--design-content-width))` |

`--design-mono-font` is the one property the owner does not choose. It is the
framework's fixed-width font for a small technical detail. Every other property
follows a registered token option.

If a component needs a colour that is not in the table, add it to the table.
Declare it on `.site-canvas` in `globals.css`, and derive it from a registered
token option in `packages/site-definition/src/design-tokens.ts` — either by
reading a token the contract already registers, or by adding a value to a token
option there with an owner-readable label. Do not add it to the component's own
rule.

## How the rule is enforced here

- `apps/reference-site/src/page-component-stylesheet.test.ts` reads
  `apps/reference-site/app/public.css` and fails on a literal colour, a literal
  font family, or any custom property that is not a `--design-*` one, in any
  declaration that paints.
- `apps/reference-site/components/page-component-design-tokens.browser.test.tsx`
  renders every registered page component under two preset looks that differ in
  every token. It compares only the values a component paints for itself, and
  fails when one of them is the same under both looks. Compare whole subtrees
  instead and the test can never fail, because everything below `.site-canvas`
  inherits a colour and a font that already differ.
- `apps/reference-site/src/design-stylesheet.test.ts` keeps `globals.css` and
  the design contract in agreement.
- `packages/site-definition/src/design-presets.test.ts` checks every colour the
  owner can end up with is still readable: page text on the paper, on the card
  and on the light band, and the accent's own ink on the accent and its deep
  shade.

Copy all of these. The browser test alone is not enough: `--design-accent-ink`
is white under every look, so a hand-written `color: #fff` would slip past it.
The stylesheet test is what reads the source and catches that.

## The duty of a client installation

A client installation hand-ports `apps/reference-site/foundry/page-components.tsx`
and the styles beside it. Those copied styles are not covered by the tests in
this repository.

**An installation page component that ignores the design tokens is a defect in
that installation.** Fix it in the installation. The owner of that site chose a
look, and the component must follow it.

Copy the tests above into the installation as well. They read the
installation's own stylesheet and its own component registry, so they hold the
same rule there.
