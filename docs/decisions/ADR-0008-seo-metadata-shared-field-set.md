# ADR-0008: One SEO and sharing field set, with a derived canonical URL

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

[Issue #113](https://github.com/Humber-Foundry/foundry-cms/issues/113) asks for
the metadata that decides how content looks in a search result and in a link
preview. It must cover three surfaces — site pages, blog posts and newsletter
campaigns — and it must reach the real output: `<title>`, the meta description,
the canonical URL, and the Open Graph and Twitter tags.

[Issue #114](https://github.com/Humber-Foundry/foundry-cms/issues/114) will add
an AI auto-draft that fills these fields. It needs one target, not three.

Before this decision the Site Definition carried `seo: { title, description }`
on the home page and on each post, and nothing else. No canonical, Open Graph
or Twitter tag was emitted anywhere in the repository. A campaign already had
`subject` and `previewText`, which are its meta title and meta description.

Three questions had to be answered.

### Where the canonical URL comes from

A canonical URL is absolute. The renderer therefore needs the site's own
address, and the public pages are statically rendered at build time from the
bundled Site Definition, so the address has to be known then.

Two sources were available:

- `FOUNDRY_CANONICAL_ORIGIN`, an existing Worker setting. It is a request
  integrity control: it names the origin a dashboard mutation must come from.
  Reading it in `generateMetadata` would make a public page depend on Worker
  environment at build time.
- The Site Definition itself, which already carries the site's name,
  description, navigation and footer, and which an installation owns.

### Whether the owner writes the canonical URL

Yoast and Rank Math both offer a canonical override. An override that is wrong
is one of the worst faults an SEO panel can produce, because it silently tells
a search engine to index a different page.

### How a share image is named

Media assets are managed objects in a private R2 bucket, addressed through
`/api/media/<assetId>`, but a media occurrence is keyed by a closed enum of two
home-page slots. Blog posts carry no media field at all, and campaigns are not
part of the Site Definition.

## Decision

**One `SeoMetadata` block, used by every surface.** It holds `title`,
`description`, `keywords` and `shareImage`. The home page and every blog post
carry it in the Site Definition. A campaign carries the same `shareImage`
alongside its existing `subject` and `previewText`, which serve as its title
and description. Site Definition schema moves to 1.4.0.

**Every field may be left blank, and blank means "use the fallback".** The
schema was relaxed to allow an empty title and description. The fallback rules
live in one pure module, `packages/site-definition/src/seo.ts`:

- Blank SEO title on a post becomes `<post title> — <site name>`, matching what
  an owner expects from Yoast. A filled SEO title is used exactly as written.
- Blank SEO description becomes the post excerpt, then the site description.
- Blank share image becomes the home page share image, then the home hero media
  occurrence.

**The canonical URL is derived, never typed.** `site.canonicalOrigin` joins the
Site Definition and is combined with the route path — `/` for the home page,
`/blog/<slug>` for a post. The owner's control over the canonical URL is the
slug, which they already edit. When `canonicalOrigin` is empty the renderer
emits no canonical URL and no absolute share URL at all.

**A share image is a URL and an alt text, not an asset reference.** For a page
or post the URL may be a path on the site, such as `/api/media/asset_hero`,
which the renderer makes absolute using the canonical origin. For a campaign it
must be an absolute `https://` address.

## Consequences

An installation upgrading from 1.3.0 needs no content migration. The projection
in `site-definition-projection.mjs` fills `canonicalOrigin` with `""`, and every
SEO block with `keywords: []` and `shareImage: null`. A site therefore renders
exactly what it rendered before until an owner fills the new fields.

An installation must set `site.canonicalOrigin` in its published content before
canonical and Open Graph URLs appear. Until it does, the pages still emit a
title, a description and Open Graph title and description — only the addresses
are withheld. This is deliberate: no canonical URL is safer than one pointing at
the wrong host.

`site.canonicalOrigin` and `FOUNDRY_CANONICAL_ORIGIN` are normally the same
value, but they are not the same setting and nothing enforces agreement. The
first is the public site's own address, used for canonical and share URLs. The
second is the dashboard's request-integrity origin. They are separate because
one is build-time content and the other is a runtime security control.

A campaign share image cannot be a path. An email is read outside the site, so a
path would resolve against the reader's mail host. A campaign derived from a
post therefore inherits the post's share image only when it is already absolute.

Because the share image is a URL rather than an asset reference, an owner can
point a page at an asset that the public media route will not serve. The route
still serves only assets published in `home.media`, so such a link 404s rather
than leaking a private object.

The SEO block is bound into the blog post artifact fingerprint, so changing a
share image or a keyword produces a new fingerprint. An approval cannot carry
over to sharing copy the approver never saw.

Both `additionalProperties: false` and the generated Ajv validator mean any
future field needs the same version bump, projection step and regenerated
validator this change made.
