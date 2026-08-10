import { describe, expect, it } from "vitest";

import {
  createPageComponentRegistry,
  createRegisteredPageComponent,
  foundationPageComponentRegistry,
  isSiteDefinitionWithPageComponents,
  applyPageComposition,
  toPageComposition,
  referenceSiteDefinition,
} from "./index";

const story = createRegisteredPageComponent({
  type: "imageCopyStory",
  label: "Image and copy story",
  fields: {
    eyebrow: {
      control: "text",
      label: "Eyebrow",
      defaultValue: "A shared practice",
    },
    title: {
      control: "text",
      label: "Title",
      defaultValue: "Make room for a better question",
    },
    body: {
      control: "textarea",
      label: "Body",
      defaultValue: "A generous workshop starts with curiosity.",
    },
    imageSrc: {
      control: "image",
      label: "Image",
      defaultValue: "/workshop.svg",
    },
    imageAlt: {
      control: "text",
      label: "Image description",
      defaultValue: "People sharing ideas around a workshop table",
    },
  },
});

const registry = createPageComponentRegistry(
  foundationPageComponentRegistry,
  [story],
);

describe("installation-owned page component registry", () => {
  it("provides typed defaults and editable metadata for a registered component", () => {
    const section = registry.createDefault(
      "imageCopyStory",
      "section_story",
      referenceSiteDefinition,
    );

    expect(section).toEqual({
      id: "section_story",
      type: "registered",
      component: "imageCopyStory",
      props: {
        eyebrow: "A shared practice",
        title: "Make room for a better question",
        body: "A generous workshop starts with curiosity.",
        imageSrc: "/workshop.svg",
        imageAlt: "People sharing ideas around a workshop table",
      },
    });
    expect(registry.components.imageCopyStory.editableFields).toEqual([
      "eyebrow",
      "title",
      "body",
      "imageSrc",
      "imageAlt",
    ]);
  });

  it("validates an installed definition through its registry and fails closed elsewhere", () => {
    const definition = {
      ...referenceSiteDefinition,
      home: {
        ...referenceSiteDefinition.home,
        sections: [
          ...referenceSiteDefinition.home.sections,
          registry.createDefault(
            "imageCopyStory",
            "section_story",
            referenceSiteDefinition,
          ),
        ],
      },
    };

    expect(isSiteDefinitionWithPageComponents(definition, registry)).toBe(true);
    expect(
      isSiteDefinitionWithPageComponents(
        {
          ...definition,
          home: {
            ...definition.home,
            sections: [
              ...definition.home.sections.slice(0, -1),
              {
                id: "section_unknown",
                type: "registered",
                component: "notInstalled",
                props: { title: "Unsafe" },
              },
            ],
          },
        },
        registry,
      ),
    ).toBe(false);
    expect(isSiteDefinitionWithPageComponents(definition)).toBe(false);
  });

  it("rejects unknown fields, blank required values, and unsafe image sources", () => {
    const valid = registry.createDefault(
      "imageCopyStory",
      "section_story",
      referenceSiteDefinition,
    );
    if (valid.type !== "registered") throw new Error("expected_registered_component");
    const invalid = {
      ...valid,
      props: {
        ...valid.props,
        title: " ",
        imageSrc: "javascript:alert(1)",
        extra: "not registered",
      },
    };

    expect(registry.validate(invalid)).toEqual({
      ok: false,
      errors: {
        "section_story.props": "Use only fields registered by this component.",
        "section_story.props.imageSrc": "Use a safe site image path or HTTPS image URL.",
        "section_story.props.title": "Enter at least one visible character.",
      },
    });
  });

  it("applies insert, edit, reorder, duplicate, and removal through the installed registry", () => {
    const first = registry.createDefault(
      "imageCopyStory",
      "section_story",
      referenceSiteDefinition,
    );
    if (first.type !== "registered") throw new Error("expected_registered_component");
    const inserted = applyPageComposition(
      referenceSiteDefinition,
      {
        ...toPageComposition(referenceSiteDefinition),
        components: [first, ...referenceSiteDefinition.home.sections],
      },
      registry,
    );
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;

    const duplicate = {
      ...first,
      id: "section_story_copy",
      props: { ...first.props, title: "A copied story" },
    };
    const changed = applyPageComposition(
      inserted.definition,
      {
        ...toPageComposition(inserted.definition),
        components: [
          duplicate,
          ...inserted.definition.home.sections.filter(
            ({ id }) => id !== "section_story",
          ),
        ],
      },
      registry,
    );
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.definition.home.sections[0]).toMatchObject({
      id: "section_story_copy",
      type: "registered",
      component: "imageCopyStory",
      props: { title: "A copied story" },
    });
    expect(changed.definition.home.sections.some(({ id }) => id === "section_story")).toBe(false);
  });
});
