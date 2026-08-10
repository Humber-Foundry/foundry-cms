# Installation-owned Site Definition

This directory is the client repository's boundary from the synchronized
Foundry foundation.

- `published-site.json` is the installation-owned Git publication target.
  Import or edit content through Foundry so revisions continue through the
  normal preview, approval, and publication path.
- `site-definition.ts` is browser-safe. It validates and types that published
  content together with the client's registered renderer inputs.
  Never import environment variables, credentials, database bindings, or
  server adapters there.
- `page-components.tsx` is the browser-safe installation registry. Add a
  component there with a stable type, declarative field schema, defaults, and
  its real React renderer. Public pages, exact revision previews, and the Puck
  canvas all dispatch through that registry; unknown or schema-invalid
  components are rejected before they can be saved or published.
- `site-definition.server.ts` is server-only. It binds that definition to the
  site-scoped application runtime. Client-owned private adapters belong on this
  side of the boundary.

Foundation runtime modules obtain site identity and published content through
these files. An adopted repository can therefore change its installation
without modifying published `@humber-foundry/*` packages or synchronized
foundation source.
