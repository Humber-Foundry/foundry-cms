import { describe, expect, it } from "vitest";

import {
  designContract,
  listEditableSiteFields,
  referenceSiteDefinition,
  updateEditableSiteField,
} from "@humber-foundry/site-definition";

import {
  designControlGroups,
  optionColumns,
} from "./design-destination-controls";

const groups = designControlGroups(referenceSiteDefinition);
const controls = groups.flatMap((group) => group.controls);
const designFields = listEditableSiteFields(referenceSiteDefinition).filter(
  (field) => field.group === "Design",
);

describe("design studio controls", () => {
  it("offers every Design field of the draft, and nothing else", () => {
    expect(controls.map(({ path }) => path).sort()).toEqual(
      designFields.map(({ path }) => path).sort(),
    );
  });

  it("shows the draft's current value for every control", () => {
    for (const control of controls) {
      const field = designFields.find(({ path }) => path === control.path)!;
      expect(control.value, control.path).toBe(field.value);
      expect(
        control.options.map((option) => option.value),
        control.path,
      ).toEqual(field.values);
    }
  });

  it("labels every group, control and option in plain words", () => {
    for (const group of groups) {
      expect(group.title).toMatch(/^[A-Z]/u);
      expect(group.help).toMatch(/^[A-Z].*\.$/su);
      expect(group.controls.length).toBeGreaterThan(0);
      for (const control of group.controls) {
        expect(control.label, control.path).toMatch(/^[A-Z]/u);
        expect(control.help, control.path).toMatch(/^[A-Z].*\.$/su);
        for (const option of control.options) {
          expect(option.label, `${control.path}:${option.value}`).toMatch(
            /^[A-Z]/u,
          );
          expect(
            option.description,
            `${control.path}:${option.value}`,
          ).toMatch(/^[A-Z].*\.$/su);
        }
      }
    }
  });

  it("draws a preview for every token option so each one shows its effect", () => {
    const tokenPaths = new Set(
      Object.keys(designContract.tokens).map((key) => `design.${key}`),
    );
    for (const control of controls) {
      for (const option of control.options) {
        expect(
          option.preview !== undefined,
          `${control.path}:${option.value}`,
        ).toBe(tokenPaths.has(control.path));
      }
    }
  });

  it("offers only values the draft accepts", () => {
    for (const control of controls) {
      for (const option of control.options) {
        expect(
          updateEditableSiteField(referenceSiteDefinition, {
            path: control.path,
            value: option.value,
          }),
          `${control.path}:${option.value}`,
        ).not.toBeNull();
      }
    }
  });

  it("lays every control's options out in complete rows", () => {
    for (const control of controls) {
      expect(
        control.options.length % optionColumns(control.options.length),
        control.path,
      ).toBe(0);
    }
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(optionColumns)).toEqual([
      1, 2, 3, 2, 1, 3, 1, 2, 3,
    ]);
  });

  it("puts every section on the page in the section styles group", () => {
    const sectionStyles = groups.find(
      (group) => group.title === "Section styles",
    );

    expect(sectionStyles?.controls.map(({ path }) => path)).toEqual([
      "section_hero.variant",
      "section_services.variant",
      "section_proof.variant",
      "section_contact.variant",
    ]);
  });
});
