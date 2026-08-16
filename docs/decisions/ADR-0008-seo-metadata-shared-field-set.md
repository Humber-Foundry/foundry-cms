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
emits no canonical URL and no absolute share URL at all. The origin itself is an
editable field, "Site address", in the SEO group, so an owner sets it in the
dashboard rather than by hand-editing published content.

**A share image is a URL and an alt text, not an asset reference.** For a page
or post the URL may be a path on the site, such as `/api/media/asset_hero`,
which the renderer makes absolute using the canonical origin. For a campaign it
must be an absolute `https://` address.

**One share image is two editable fields.** An editable Site Definition field
holds one string, and that is what the field-group editor, the save endpoint and
the MCP `foundry.content.patch` contract all assume. The address and the
description are therefore separate fields that each write their own half. A pair
left with a description but no address is dropped once every edit in a batch has
been written, not while writing, because a later edit in the same batch may be
about to supply the address.

**A campaign emits no Open Graph tag.** The rendered campaign bytes are only
ever sent to the delivery provider as the message body, and a mail client
discards `<head>`. An `og:image` there would be markup nobody reads, inside the
bytes the send fingerprint covers. The share image reaches the reader as a
picture in the body instead. The preview line stays the first thing in that
body, because an inbox builds its preview from the first text it finds.

**A listing borrows the site's metadata.** The blog index is a route the product
generates, not content an owner writes, so it has no SEO block to fill. It takes
the site name, the site description and the home page's share image. Giving it
editable fields would ask an owner to write metadata for a page they did not
write; leaving it with the hand-written title it had before would have been the
one public route with no canonical URL and no Open Graph tags.

## What this decision does not cover

**A slug for site pages.** The issue asks for one. A Site Definition has exactly
one page, `home`, served at the site root, and no page collection exists to give
a slug to. A slug here would be a name for a route that cannot vary. Multi-page
sites are a separate piece of work, and a page slug belongs with them. Blog
posts already have a slug, and it is now the owner's control over the canonical
URL, so it sits in the post composer's "SEO and sharing" section rather than
with the post's other settings.

**A hidden pre-header for campaigns.** The preview line is delivered as the
first visible paragraph of the message, which is what an inbox reads. Making it
a hidden pre-header block, so it shows in the inbox list but not in the opened
message, changes what a reader sees and is its own piece of work.

**A share image fallback for a standalone campaign.** A campaign is not part of
the Site Definition and has no page to inherit from, so a campaign written from
scratch shows no picture unless the owner gives one. A campaign derived from a
post does inherit that post's share image, made absolute with the site's
canonical origin.

## Consequences

An installation upgrading from 1.3.0 needs no content migration. The projection
in `site-definition-projection.mjs` fills `canonicalOrigin` with `""`, and every
SEO block with `keywords: []` and `shareImage: null`. A site therefore renders
exactly what it rendered before until an owner fills the new fields.

An installation must set its site address before canonical and Open Graph URLs
appear. An owner sets it in the dashboard as the "Site address" field, which
writes `site.canonicalOrigin`. Until it is set, the pages still emit a title, a
description and Open Graph title and description — only the addresses are
withheld. This is deliberate: no canonical URL is safer than one pointing at the
wrong host.

The share image the home hero supplies as a last resort carries no description,
because a media occurrence holds no alt text. The renderer then emits the image
address with no `og:image:alt`, rather than an empty one. An owner who wants the
picture described fills the share image fields, which have their own
description box.

A campaign's preview line reaches the reader as the first paragraph of the
message. The delivery provider has no separate pre-header field to carry it, so
this is where an inbox finds it.

In the field-group editor a post's SEO fields sit in the "Blog" group with the
rest of that post's fields, because that editor groups by destination and the
"SEO" group belongs to the home page. The owner-facing surface for a post is the
blog composer, which does have its own "SEO and sharing" section.

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
