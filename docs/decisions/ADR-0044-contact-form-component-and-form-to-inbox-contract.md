# ADR-0044: The contact form is a foundation page component, and a page block names the declared form it sends to

- **Status:** Accepted
- **Date:** 2026-09-21

## Context

Before #235 a site could declare a public form and serve its endpoint, but no
page component put that form on a page. `apps/reference-site/foundry/public-forms.ts`
declared the `contact` form, and
`apps/reference-site/app/api/forms/[formId]/submissions/route.ts` accepted
messages for it, yet nothing on the public site ever posted to that route. So
no visitor could send a message, and the Messages inbox could never fill. The
owner read the empty inbox as "this has not been built".

The Messages screen also said nothing about which forms the site has, or where
a visitor would find them. An owner looking at an empty inbox had no way to
tell an unused form from a form nobody can see.

Three questions had to be answered.

**Where does the contact form component live?** In the foundation registry
(`packages/site-definition/src/page-component-registry.ts`), so every
installation has one, or in each installation's own component file
(`apps/reference-site/foundry/page-components.tsx`), so each installation
writes its own.

**How is the component typed?** As its own Site Definition section type, next
to `hero`, `services`, `proof` and `callToAction`, or inside the stable
`registered` envelope every installation-defined component already uses.

**How does a block know which form to send to?** By a fixed rule in code, or
by a stored field on the block.

## Decision

**The contact form is a foundation page component named `contactForm`.** It is
registered in `foundationPageComponentRegistry`, so every installation gets it
and an agent can add it through MCP on any installation. The installation still
supplies the renderer, the same way it does for `hero` and the other foundation
components.

**It uses the `registered` envelope, not a new section type.** The component is
`{ type: "registered", component: "contactForm", props: { … } }`. The reasons:

- **No schema change, so no installation is stranded.** The
  `registeredPageSection` shape is already in the JSON Schema and already
  accepts any component name. A new section type would need a schema version
  bump, a regenerated validator, and an upgrade path for every stored draft and
  published file, for a block that adds no new kind of value.
- **The block's fields are ordinary text.** A heading, a sentence and a button
  label need no new field control, so nothing is gained by giving them their
  own place in the schema.

**A block names the form it sends to, in a field the owner cannot edit.** The
`formId` field is stored with the block and defaults to `contact`. It is
`editable: false`, so the editor and MCP both refuse to change it: a block
pointed at a form the site does not declare would send every message into
nothing. An installation that renames or adds a form changes the value where
the block is scaffolded, not through the editor.

**The form's own fields are fixed, and the words around them are the owner's.**
The heading, the sentence under it and the button label are editable. The three
fields come from the declared form, and the inbox reads them by the roles that
declaration gives them (`sender`, `replyAddress`, `preview`). An owner who
could add a field would produce messages the inbox cannot summarize.

**The block asks before it draws a field.** `GET /api/forms/<formId>/submissions`
answers `available`, `schemaVersion` and `turnstileSiteKey`, and nothing else.
This mirrors the newsletter signup form (ADR-0031's public status rule): a field
that looks ready and then refuses every message is worse than a plain sentence
saying the form is not ready. The answer names no setting and carries no secret,
so a visitor learns nothing about how the site is configured. An unknown form id
and a missing setting give the same answer.

**The block sends nothing on an editing surface.** With `previewOnly` set — the
page editor canvas and the Design preview — the form draws itself, disables
every control, draws no automated-traffic check and makes no request at all. An
owner arranging a page must not fill their own inbox.

**Every declared form is named on its own terms.** `InstalledPublicFormDefinition`
now carries a required `name`, and `isInstalledPublicFormList` refuses a form
without one. Messages prints that name. No screen has to show a form id.

**Messages lists the forms the site has.** "Forms on your site" reads the
declared forms and walks the **draft** definition's pages for `contactForm`
blocks, so a block the owner has just placed is listed before the site is
published. Each row names the form, links to every page it appears on, and says
how many messages it has brought in. A declared form on no page is listed and
says so, because that is the reason an inbox stays empty.

**Counting messages reads no message.** `countInboxByForm` is a separate store
query that groups accepted submissions by form id. It is behind the same
`forms.review` capability as the inbox, and it never loads a stored field.

**The block draws itself from the design tokens.** Its stylesheet rules in
`apps/reference-site/app/public.css` set no literal colour and no literal font
family; every value comes from a design token custom property. A different
preset look therefore changes this block, which is the contract #233 is
writing down for every page component.

## Consequences

- Every installation, including one that hand-ports `page-components.tsx`, has
  a contact form available and must supply a renderer for it if it wants one on
  a page.
- `pageCompositionContract.slot.allowedComponents` gained `contactForm`, so the
  MCP tool schemas that carry that list changed. The MCP snapshots were
  regenerated.
- An installation that declares a form must now give it a `name`. A form list
  without one stops the installation at start-up, which is the same loud
  failure the rest of that guard already gives.
- A visitor's whole path cannot be run end to end on a development machine:
  `next dev` has no D1 database, no rate limiter and no real Turnstile key. The
  path is covered in two joined halves instead —
  `scripts/verify-contact-form-browser.mjs` drives the real rendered form in a
  browser and checks the exact request the route would receive, and
  `apps/reference-site/src/contact-form-to-inbox.test.ts` runs that same
  envelope through the real acceptance rules and the real store, then reads the
  message back as the inbox reads it.
- #236 rebuilds the inbox rows and the message view. This decision does not
  touch either.
