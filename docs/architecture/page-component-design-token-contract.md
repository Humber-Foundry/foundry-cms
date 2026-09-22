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
| `color: #212530` on a heading | `color: var(--design-heading-ink)` |
| `color: #343947` on a paragraph | `color: var(--design-body-ink)` |
| `background: #fffaf0` on a card | `background: var(--design-card)` |
| `background: #8298cd` on a band | `background: var(--design-band)` |
| `background: #17a578` on a strong band | `background: var(--design-band-strong)` |
| `color: #ffffff` on the accent | `color: var(--design-accent-ink)` |
| `border: 2px solid #212530` | `border: 2px solid var(--design-frame)` |
| `box-shadow: … rgba(33, 37, 48, 0.14)` | `box-shadow: … var(--design-shadow)` |
| `font-family: var(--font-serif)` | `font-family: var(--design-heading-font)` |
| `width: 78rem` | `width: min(100%, var(--design-content-width))` |

If a component needs a colour that is not in the table, add it to the table.
Declare it on `.site-canvas` in `globals.css`, derive it from a registered token
option in `packages/site-definition/src/design-tokens.ts`, and give it an
owner-readable label there. Do not add it to the component's own rule.

## How the rule is enforced here

- `apps/reference-site/src/page-component-stylesheet.test.ts` reads
  `apps/reference-site/app/public.css` and fails on a literal colour, a literal
  font family, or any custom property that is not a `--design-*` one, in any
  declaration that paints.
- `apps/reference-site/components/page-component-design-tokens.browser.test.tsx`
  renders every registered page component under two preset looks that differ in
  every token, and fails when a component paints the same either way.
- `apps/reference-site/src/design-stylesheet.test.ts` keeps `globals.css` and
  the design contract in agreement.

## The duty of a client installation

A client installation hand-ports `apps/reference-site/foundry/page-components.tsx`
and the styles beside it. Those copied styles are not covered by the tests in
this repository.

**An installation page component that ignores the design tokens is a defect in
that installation.** Fix it in the installation. The owner of that site chose a
look, and the component must follow it.

Copy the two tests above into the installation as well. They read the
installation's own stylesheet and its own component registry, so they hold the
same rule there.
