import { describe, expect, it } from "vitest";

import { pageCompositionContract } from "@humber-foundry/site-definition";

import { pageCompositionFailureMessage } from "./page-composition-failure-message";

const internalWords = ["slot", "Site Definition", "Puck"];

describe("page composition failure sentences", () => {
  it("maps every known refusal reason to its own plain sentence", () => {
    const cases: ReadonlyArray<[string, string]> = [
      [
        "This slot is not registered by the Site Definition.",
        "This change does not belong to this page. Reload the page and try again.",
      ],
      [
        "Use only fields registered by the Site Definition.",
        "This change used a field this page does not have. Reload the page and try again.",
      ],
      [
        "Provide the registered components for this slot.",
        "This page needs at least one section.",
      ],
      [
        `Use ${pageCompositionContract.slot.minItems}–${pageCompositionContract.slot.maxItems} components.`,
        `Use between ${pageCompositionContract.slot.minItems} and ${pageCompositionContract.slot.maxItems} sections on this page.`,
      ],
      [
        "Every slot item must be a registered component.",
        "Every section on this page must be a real section. Reload the page and try again.",
      ],
      [
        "Use a stable section identifier.",
        "This section could not be saved with a valid identifier. Reload the page and try again.",
      ],
      [
        "Component identifiers must be unique in the slot.",
        "Two sections on this page ended up with the same identifier. Reload the page and try again.",
      ],
      [
        "This component is not registered for the page slot.",
        "That kind of section is not available on this page.",
      ],
      [
        "An existing component cannot change its registered type.",
        "An existing section cannot change to a different kind of section.",
      ],
      [
        "This component scaffolding is protected by the Site Definition.",
        "Part of this section is protected and cannot be changed here.",
      ],
      [
        "Every component and nested item needs a unique stable identifier.",
        "Two items on this page ended up with the same identifier. Reload the page and try again.",
      ],
      [
        "This component is referenced by protected page scaffolding.",
        "This section cannot be removed. Another part of the page still links to it.",
      ],
      [
        "The visual editor returned an invalid page slot.",
        "The page editor sent an unexpected change. Reload the page and try again.",
      ],
      [
        "Only registered page components can enter this slot.",
        "That is not a section this page can use.",
      ],
      [
        "Every Puck component needs one unique stable identifier.",
        "Every section needs its own identifier. Reload the page and try again.",
      ],
      [
        "The visual editor must preserve the versioned rich-text document.",
        "That text could not be saved in the format this page expects. Reload the page and try again.",
      ],
    ];
    for (const [reason, sentence] of cases) {
      expect(pageCompositionFailureMessage(reason)).toBe(sentence);
    }
  });

  it("falls back to a generic sentence for a reason it does not know", () => {
    expect(pageCompositionFailureMessage("some_new_internal_reason")).toBe(
      "This change to the page could not be saved. Reload the page and try again.",
    );
  });

  it("falls back to the generic sentence when no reason is given", () => {
    expect(pageCompositionFailureMessage(undefined)).toBe(
      "This change to the page could not be saved. Reload the page and try again.",
    );
    expect(pageCompositionFailureMessage("")).toBe(
      "This change to the page could not be saved. Reload the page and try again.",
    );
  });

  it("never puts an internal word on screen, known reason or not", () => {
    const knownReasons = [
      "This slot is not registered by the Site Definition.",
      "The visual editor must preserve the versioned rich-text document.",
      "an_unknown_reason",
    ];
    for (const reason of knownReasons) {
      const sentence = pageCompositionFailureMessage(reason);
      for (const word of internalWords) {
        expect(sentence).not.toContain(word);
      }
    }
  });
});
