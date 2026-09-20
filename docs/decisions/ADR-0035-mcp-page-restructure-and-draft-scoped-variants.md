# ADR-0035: An agent changes a page's sections through one operation list, and every section style is checked against the draft

- **Status:** Accepted
- **Date:** 2026-09-20

## Context

An agent can now address every page, edit its text, and add, rename, copy and
delete pages ([ADR-0034](ADR-0034-mcp-addresses-every-page.md)). It still could
not change what a page is made of. A page's sections are its structure, and the
only surface that changed them was the visual editor in the dashboard.

[Issue #146](https://github.com/Humber-Foundry/foundry-cms/issues/146) records
what the site owner asked for: an agent must be able to restructure pages.

Two things stood in the way.

The first is that the section rules were written for a drag-and-drop editor.
The editor sends the whole section list of one page and the boundary
`applyPageComposition` decides whether that list is allowed. An agent cannot
send a whole section list: it would have to rebuild every protected part of
every section it did not touch, and any mistake would be refused as tampering.

The second is the gap ADR-0034 left behind. `foundry.design.patch` built its
list of component variants at module load from the installed site, so it could
name only the sections the published home page already held. A section on
another page, or on a page an agent made inside a draft, could not have its
section style changed at all.

## Decision

**One tool changes a page's sections through a short list of named operations,
and a section style is always checked against the draft.**

### 1. Five operations, and no section-writing among them

`foundry.page.restructure` takes one page and one to twenty-four operations:

- `add` a registered section type at a position, optionally with a
  section style;
- `remove` a section;
- `move` a section to a position;
- `duplicate` a section, which puts the copy straight after it;
- `set_variant`, which chooses a section's style.

The operations are carried out in the order they are given, against the section
list as it stands at that step, so an agent can add a section and move it in
one request. The whole list becomes one new immutable revision, whatever it
carries.

There is no operation that writes a section's words. A section's words are
editable fields, and `foundry.content.patch` writes them, the same as every
other field. Two ways to write the same value would drift.

Raw HTML, CSS, JavaScript, a component module and a slot definition stay out,
as [issue #1](https://github.com/Humber-Foundry/foundry-cms/issues/1) decides.
An agent names a registered section type and nothing else.

### 2. The plan is domain work, the write is the editor's own boundary

`planPageSectionRestructure` reads the page and answers what the page would
hold. It builds a new section only through `createDefaultPageSection` and
copies one only through `remapPageSectionNestedIds`, so a section an agent adds
is the same section the visual editor adds. It writes nothing.

The plan is then written through `applyPageComposition`, which is the boundary
the dashboard writes through. Every structural rule stays where it already was:
one to twelve sections, no duplicate identifier, no changed component type, no
tampered scaffolding, and no section removed while a button still links to it.
Nothing is repeated here, for the reason ADR-0033 gives.

`composedAndEditedDefinition` is the one function that writes a composition and
then applies field edits. `save`, which the dashboard calls, and
`restructurePage` both go through it.

### 3. Choosing a section style needs the design scope; changing the structure does not

A page's structure is content: which sections a page holds is what the page
says, not how it looks. So every restructure needs `content.draft`.

A section style is a design value. So a request that names one — through
`set_variant`, or through `variant` on an `add` — needs `design.draft` as well.
The scopes are read from the request before anything is loaded, so an agent
that lacks the scope is told which scope it lacks and can ask the owner for it,
rather than being refused after the work is planned.

This keeps the boundary ADR-0034 drew, and tightens one edge of it. ADR-0034
allowed a content-scoped connection to add a page whose sections carry the
section styles the starting point placed, because those are defaults nobody
chose. Here the agent does choose, so the design scope is required whether the
section is new or old.

The style of a section the page already held is written as an edit to that
section's own field, because it is a design value on a record both revisions
hold. The style of a section the request added is carried in the section
itself, because there is nothing to compare it with.

`duplicate` therefore needs `content.draft` only, even when the section it
copies carries a style the owner chose. The copy is a new record, and the agent
named no style: it asked for the section that is already there. This is the
same reading `foundry.page.duplicate` already works under, which copies a whole
page with every section style on it under `content.draft`
([ADR-0034](ADR-0034-mcp-addresses-every-page.md)). An agent that wants a
different style on the copy must name one, and naming one needs
`design.draft`.

### 4. `foundry.design.patch` reads the draft, and stops advertising a closed list

The `set_variant` command's `componentId` was a closed list of section
identifiers built from the installed site. It is now the same dotted shape a
section's editable field path has: the section's own identifier on the home
page, and the page identifier in front of it on every other page
([ADR-0017](ADR-0017-page-scoped-editable-field-paths.md)).

Whether that section exists, and whether it offers that section style, is
answered by the draft's own design field list at call time, where it was
already answered before this change. The schema still names every section style
any registered section offers, so a word that is not a section style at all is
still refused at the client.

This is the same move ADR-0034 made for `foundry.content.patch`, and for the
same reason: a list built at module load can only describe the installed site,
so it can never name a section on a page that does not exist yet. It closes the
gap ADR-0034 recorded in its Consequences.

`foundry.design.patch` has a new `inputSchemaSha256`, and the schema snapshot
was regenerated with this change.

### 5. Every refusal carries a named reason

`planPageSectionRestructure` raises the page lifecycle error every other page
operation raises, so its codes travel to the agent as the tool error's `reason`
exactly as ADR-0034 describes: `page_section_not_found`,
`page_section_type_unknown`, `page_section_position_invalid` and
`page_section_variant_unknown`, plus `page_not_found` for the page itself.

A refusal the composition boundary raises has no code of its own, so it carries
the reason `page_sections_refused` with the boundary's own sentences as the
message. A refused design change carries `design_setting_not_found` or
`design_value_not_registered`, which the tool reported without a reason before.

Migration `0031_mcp_page_restructure_receipts.sql` adds
`foundry.page.restructure` to the operation list `mcp_mutation_receipts`
allows, so a refusal is stored and a replayed refusal repeats the first one.

### 6. An agent can read the section types it may use

`foundry.section.list` answers with every section type this installation
registers, the words an
owner reads for it, the section styles it offers, and the fields
`foundry.content.patch` can write on it. It needs `site.read` only, because it
describes the product rather than any one draft.

It names the installation's own registry, so an installation that registers its
own sections sees them here. A field the Site Definition protects is left out,
because naming it would invite an edit that is always refused.

## Consequences

An agent can plan a redesign inside the schema: read the section types, read
the draft, restructure a page, edit the new sections' words, and prepare a
preview for the owner to approve. The publish path is unchanged, so nothing
reaches the live site without a person approving it
([ADR-0004](ADR-0004-draft-preview-publish-pipeline.md)).

A client that cached the old `foundry.design.patch` input schema sees a changed
schema on its next `tools/list`. Nothing an agent could send before is refused
now; the schema only admits more.

The MCP surface has twenty-four tools. The blog tools issue #171 also asks for
— create, update, archive, restore and a schedule request — are not in this
record. They act on the blog post collection and on the blog operations
application rather than on a page's sections, and they are their own slice of
work.

## Alternatives considered

**Let the agent send the whole section list, as the editor does.** Rejected.
The editor sends a list it built from the draft it has open, field by field. An
agent would have to rebuild every protected part of every untouched section
from the definition, and one wrong nested identifier would be refused as
tampering. A short operation list says what changed and nothing else.

**Write the section rules in the MCP layer.** Rejected for the reason ADR-0033
gives: the dashboard and the agent must refuse for the same reasons, and a rule
written twice drifts.

**Let `content.draft` alone choose a section style.** Rejected. A section style is
a design value, and `design.draft` is the scope an owner grants for design
values. Reading it as content because it arrives through a structure tool would
make the scope mean less than the owner was told it means.

**Keep `foundry.design.patch` naming a closed list and add a second tool for
draft sections.** Rejected. Two tools for one design change is the drift this
record and ADR-0033 both exist to prevent.

**Answer the section types through a resource rather than a tool.** It would
fit `foundry://schemas/design`, which already carries the design contract. A
tool was chosen because an agent that is planning a restructure is already
calling tools, and the two lists an agent needs — which sections exist and
which fields they carry — are one answer here rather than two lookups.
