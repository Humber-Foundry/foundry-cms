# Decision Log

> The index of every ADR in this project. One row per decision. The ADR files
> live alongside this file in `docs/decisions/`.

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| [ADR-0001](ADR-0001-default-form-handling-adapter.md) | Default Cloudflare form-handling adapter | Accepted | 2026-07-25 |
| [ADR-0002](ADR-0002-default-newsletter-delivery-adapter.md) | Default newsletter-delivery adapter | Accepted | 2026-07-26 |
| [ADR-0003](ADR-0003-unified-privacy-first-analytics.md) | Unified privacy-first analytics architecture | Accepted | 2026-07-26 |
| [ADR-0004](ADR-0004-draft-preview-publish-pipeline.md) | Draft, preview and publish pipeline | Accepted | 2026-07-26 |
| [ADR-0005](ADR-0005-human-authentication-authorization-boundary.md) | Human authentication and authorization boundary | Accepted, amended 2026-09-18 | 2026-07-26 |
| [ADR-0006](ADR-0006-bulk-campaign-execution-boundary.md) | Bulk campaign execution boundary | Accepted | 2026-07-30 |
| [ADR-0007](ADR-0007-mcp-publication-scope-derivation-boundary.md) | MCP publication scope derivation and enforcement boundary | Accepted | 2026-07-30 |
| [ADR-0008](ADR-0008-seo-metadata-shared-field-set.md) | One SEO and sharing field set, with a derived canonical URL | Accepted | 2026-08-15 |
| [ADR-0009](ADR-0009-design-presets-and-token-vocabulary.md) | Preset looks are derived, and the token contract owns the palette | Accepted, amended | 2026-08-15 |
| [ADR-0010](ADR-0010-messages-inbox-and-owner-notification-demotion.md) | Messages is an inbox, and the owner notification is demoted | Accepted | 2026-08-15 |
| [ADR-0011](ADR-0011-media-thumbnail-variant.md) | Browser-made media thumbnail variant | Accepted | 2026-08-15 |
| [ADR-0012](ADR-0012-page-image-field-media-reference.md) | Page-component image fields reference gallery photos | Accepted | 2026-08-16 |
| [ADR-0013](ADR-0013-blog-post-images.md) | Blog post images — main image, thumbnail and inline images | Accepted | 2026-08-16 |
| [ADR-0014](ADR-0014-campaign-images.md) | Campaign images — header, share and inline images, made absolute and served | Accepted | 2026-08-16 |
| [ADR-0015](ADR-0015-foundation-framework-sync-seam.md) | The framework/installation-owned seam and three-way foundation sync | Accepted | 2026-08-17 |
| [ADR-0016](ADR-0016-site-definition-page-collection.md) | A page collection replaces the single home page | Accepted | 2026-09-18 |
| [ADR-0017](ADR-0017-page-scoped-editable-field-paths.md) | A field path carries its page id, and the home page keeps its old paths | Accepted | 2026-09-18 |
| [ADR-0018](ADR-0018-public-page-routes.md) | One route serves every page below the home page | Accepted | 2026-09-18 |
| [ADR-0019](ADR-0019-mcp-dynamic-client-registration.md) | Dynamic client registration, and consent is the only grant | Accepted | 2026-09-18 |
| [ADR-0020](ADR-0020-dashboard-help-tip-toggletip.md) | The dashboard help control is a keyboard- and touch-reachable toggletip, not a hover tooltip | Accepted | 2026-09-18 |
| [ADR-0021](ADR-0021-connection-status-shared-component.md) | One shared component reports whether email and publishing are connected | Accepted, amended | 2026-09-18 |
| [ADR-0022](ADR-0022-navigation-links-to-pages.md) | A link can target a page, by its id, and this widens `SiteHref` without a schema step | Accepted | 2026-09-18 |
| [ADR-0023](ADR-0023-approval-fingerprint-and-review-summary-cover-every-page.md) | The approval fingerprint and the review summary cover every page | Accepted | 2026-09-18 |
| [ADR-0024](ADR-0024-editor-page-selection.md) | The address names the page being edited, and one module answers which page it is | Accepted | 2026-09-18 |
| [ADR-0025](ADR-0025-preview-review-decision-record.md) | A person's decision about a preview is its own record | Accepted | 2026-09-18 |
| [ADR-0026](ADR-0026-analytics-and-media-occurrences-per-page.md) | A view and a media occurrence belong to the page that has them | Accepted, amended 2026-09-21 | 2026-09-19 |
| [ADR-0027](ADR-0027-settings-users-first-and-role-change.md) | Settings reads Users first, and a role change is a D1-only application command | Accepted | 2026-09-19 |
| [ADR-0028](ADR-0028-connect-agent-screen-and-consent-restyle.md) | One connect-agent screen, one scope-phrase source of truth, and a readable consent failure page | Accepted | 2026-09-18 |
| [ADR-0029](ADR-0029-page-scoped-revision-preview.md) | The revision preview gets one route per page, and the preview's own page-href builder keeps a link inside it | Accepted | 2026-09-20 |
| [ADR-0030](ADR-0030-campaign-channel-configuration-is-a-value.md) | The campaign channel configuration is a value, and there is no default compliance footer | Accepted | 2026-09-19 |
| [ADR-0031](ADR-0031-newsletter-signup-pending-request.md) | A newsletter signup is a pending request, not a subscriber | Accepted | 2026-09-19 |
| [ADR-0032](ADR-0032-page-composition-slot-per-page.md) | Every page has its own section slot, and the editor writes only to the page it has open | Accepted | 2026-09-19 |
| [ADR-0033](ADR-0033-page-lifecycle-operations.md) | A page is created, renamed, duplicated and deleted by one set of application operations, and its name and web address are ordinary editable fields | Accepted | 2026-09-20 |
| [ADR-0034](ADR-0034-mcp-addresses-every-page.md) | MCP reads and writes every page, and a content field path is checked against the draft rather than against the installed site | Accepted | 2026-09-20 |
| [ADR-0035](ADR-0035-mcp-page-restructure-and-draft-scoped-variants.md) | An agent changes a page's sections through one operation list, and every section style is checked against the draft | Accepted | 2026-09-20 |
| [ADR-0036](ADR-0036-mcp-blog-post-tools.md) | An agent writes and files blog posts through the blog's own commands, and a person still decides what the public site shows | Accepted | 2026-09-20 |
| [ADR-0037](ADR-0037-mcp-photo-tools.md) | An agent adds a photo by sending its bytes, and places it through the media library's own commands | Accepted | 2026-09-20 |
| [ADR-0038](ADR-0038-blog-schedule-request-visibility-and-decline.md) | The dashboard shows an app's schedule request, and a person's decline is its own immutable record | Accepted | 2026-09-20 |
| [ADR-0039](ADR-0039-mcp-campaign-lifecycle-tools.md) | An agent reads where a newsletter stands and can ask for a send time, and only a person ever sends one | Accepted | 2026-09-20 |
| [ADR-0040](ADR-0040-page-components-paint-only-from-design-tokens.md) | A page component paints only from design tokens, and two tests fail when one does not | Accepted | 2026-09-21 |
| [ADR-0043](ADR-0043-photos-is-a-library-and-placement-belongs-to-the-editor.md) | Photos is a library, and a photo is placed where it is seen | Accepted | 2026-09-21 |
| [ADR-0046](ADR-0046-email-preview-draws-the-sent-bytes-and-a-review-precedes-a-send.md) | The email preview draws the bytes that will be sent, and a review is read before a send | Accepted | 2026-09-22 |
