# Domain docs

Foundry CMS is a single-context repository.

## Before exploring

- Read `CONTEXT.md` at the repository root.
- Read ADRs under `docs/decisions/` that touch the area being changed.

If an optional context or decision document does not exist, proceed silently.
Domain-modeling workflows create new documentation only when a term or
architectural decision is actually resolved.

## File structure

```text
/
├── CONTEXT.md
├── docs/
│   ├── agents/
│   └── decisions/
└── apps/
```

## Use the glossary vocabulary

When an issue, proposal, test, or implementation names a domain concept, use
the term defined in `CONTEXT.md`. Do not drift to a synonym the glossary
explicitly avoids.

If a required concept is missing, reconsider whether it is repository language
or record the gap for a domain-modeling workflow.

## Flag ADR conflicts

Surface any proposal or implementation that contradicts an existing ADR.
Identify the ADR and explain why reopening the decision may be warranted rather
than silently overriding it.
