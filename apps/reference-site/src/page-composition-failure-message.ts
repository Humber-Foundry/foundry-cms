import { pageCompositionContract } from "@humber-foundry/site-definition";

/**
 * One plain sentence per refusal reason `applyPageComposition` and
 * `puckDataToDefinition` (`page-composition-puck.ts`) can return. Each key is
 * the exact internal message those functions put in their `errors` map — see
 * ADR-0032 for the slot and component rules behind each one.
 *
 * Every sentence tells the site owner what to do next. No internal word —
 * "slot", "Site Definition", "Puck" — from the key ever reaches the screen.
 * Follows the pattern of `humanAccessMutationFailureMessage`
 * (`human-access-mutation-client.ts`, #150).
 */
const pageCompositionFailureReasonSentences: Readonly<Record<string, string>> = {
  "This slot is not registered by the Site Definition.":
    "This change does not belong to this page. Reload the page and try again.",
  "Use only fields registered by the Site Definition.":
    "This change used a field this page does not have. Reload the page and try again.",
  "Provide the registered components for this slot.":
    "This page needs at least one section.",
  [`Use ${pageCompositionContract.slot.minItems}–${pageCompositionContract.slot.maxItems} components.`]: `Use between ${pageCompositionContract.slot.minItems} and ${pageCompositionContract.slot.maxItems} sections on this page.`,
  "Every slot item must be a registered component.":
    "Every section on this page must be a real section. Reload the page and try again.",
  "Use a stable section identifier.":
    "This section could not be saved with a valid identifier. Reload the page and try again.",
  "Component identifiers must be unique in the slot.":
    "Two sections on this page ended up with the same identifier. Reload the page and try again.",
  "This component is not registered for the page slot.":
    "That kind of section is not available on this page.",
  "An existing component cannot change its registered type.":
    "An existing section cannot change to a different kind of section.",
  "This component scaffolding is protected by the Site Definition.":
    "Part of this section is protected and cannot be changed here.",
  "Every component and nested item needs a unique stable identifier.":
    "Two items on this page ended up with the same identifier. Reload the page and try again.",
  "This component is referenced by protected page scaffolding.":
    "This section cannot be removed. Another part of the page still links to it.",
  "The visual editor returned an invalid page slot.":
    "The page editor sent an unexpected change. Reload the page and try again.",
  "Only registered page components can enter this slot.":
    "That is not a section this page can use.",
  "Every Puck component needs one unique stable identifier.":
    "Every section needs its own identifier. Reload the page and try again.",
  "The visual editor must preserve the versioned rich-text document.":
    "That text could not be saved in the format this page expects. Reload the page and try again.",
};

const genericPageCompositionFailureSentence =
  "This change to the page could not be saved. Reload the page and try again.";

/**
 * The one plain sentence a site owner reads when the page editor refuses a
 * change. `reason` is the internal message `applyPageComposition` or
 * `puckDataToDefinition` put in their `errors` map — log it for support and
 * developers, but never show it. A reason this table does not know keeps the
 * generic sentence.
 */
export function pageCompositionFailureMessage(
  reason: string | undefined,
): string {
  if (reason === undefined || reason === "") {
    return genericPageCompositionFailureSentence;
  }
  return (
    pageCompositionFailureReasonSentences[reason] ??
    genericPageCompositionFailureSentence
  );
}
