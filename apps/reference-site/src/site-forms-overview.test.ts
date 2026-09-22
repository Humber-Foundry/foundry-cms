import { describe, expect, it } from "vitest";

import {
  foundationPageComponentRegistry,
  homePage,
  referenceSiteDefinition,
  replacePage,
  type SiteDefinition,
  type SitePage,
} from "@humber-foundry/site-definition";

import { installedPublicForms } from "../foundry/public-forms";
import { installedSiteDefinition } from "../foundry/site-definition";
import {
  formMessageCountSentence,
  formPlacementAndCountSentence,
  formRowDestination,
  siteFormsOverview,
} from "./site-forms-overview";

function contactFormSection(id: string, formId = "contact") {
  const section = foundationPageComponentRegistry.createDefault(
    "contactForm",
    id,
  ) as { id: string; type: "registered"; component: string; props: Record<string, unknown> };
  return { ...section, props: { ...section.props, formId } };
}

function withHomeSections(
  definition: SiteDefinition,
  sections: SitePage["sections"],
): SiteDefinition {
  return replacePage(definition, { ...homePage(definition), sections });
}

/** A site whose pages hold no contact form block. */
const emptySite = withHomeSections(
  referenceSiteDefinition,
  homePage(referenceSiteDefinition).sections.filter(
    (section) =>
      !(section.type === "registered" && section.component === "contactForm"),
  ),
);

/** The same site with the contact form block back on the home page. */
const placedSite = withHomeSections(emptySite, [
  ...homePage(emptySite).sections,
  contactFormSection("section_contact_form"),
]);

describe("the forms on your site", () => {
  it("lists every declared form with its name and its message count", () => {
    expect(
      siteFormsOverview(placedSite, installedPublicForms, { contact: 3 }),
    ).toEqual([
      {
        formId: "contact",
        name: "Contact form",
        placements: [{ pageTitle: homePage(placedSite).title, pagePath: "/" }],
        messageCount: 3,
      },
    ]);
  });

  it("counts a form with no messages as none", () => {
    const [row] = siteFormsOverview(placedSite, installedPublicForms);
    expect(row!.messageCount).toBe(0);
    expect(formMessageCountSentence(row!)).toBe("No messages yet.");
    expect(formMessageCountSentence({ ...row!, messageCount: 1 })).toBe(
      "1 message received.",
    );
    expect(formMessageCountSentence({ ...row!, messageCount: 4 })).toBe(
      "4 messages received.",
    );
  });

  it("says plainly when a declared form is on no page", () => {
    const [row] = siteFormsOverview(emptySite, installedPublicForms);
    expect(row!.placements).toEqual([]);
    expect(formPlacementAndCountSentence(row!)).toBe(
      "On no page, so nobody can send a message. No messages yet.",
    );
    // The row still opens somewhere useful: the screen where a page is
    // edited, so the owner can go and place the form.
    expect(formRowDestination(row!)).toBe("/dash/pages");
  });

  it("names the page and its address once the form is on a page", () => {
    const [row] = siteFormsOverview(placedSite, installedPublicForms, {
      contact: 2,
    });
    expect(formPlacementAndCountSentence(row!)).toBe(
      `Appears on ${homePage(placedSite).title} (/). 2 messages received.`,
    );
    expect(formRowDestination(row!)).toBe("/");
  });

  it("names each page once, however many blocks that page holds", () => {
    const definition = withHomeSections(emptySite, [
      ...homePage(emptySite).sections,
      contactFormSection("section_contact_form_one"),
      contactFormSection("section_contact_form_two"),
    ]);
    const [row] = siteFormsOverview(definition, installedPublicForms);
    expect(row!.placements).toEqual([
      { pageTitle: homePage(definition).title, pagePath: "/" },
    ]);
  });

  it("leaves a block that names another form out of this form's pages", () => {
    const definition = withHomeSections(emptySite, [
      ...homePage(emptySite).sections,
      contactFormSection("section_other_form", "enquiries"),
    ]);
    const [row] = siteFormsOverview(definition, installedPublicForms);
    expect(row!.placements).toEqual([]);
  });

  it("finds the block this installation ships on its own home page", () => {
    const [row] = siteFormsOverview(
      installedSiteDefinition,
      installedPublicForms,
    );
    expect(row!.placements).toEqual([
      { pageTitle: homePage(installedSiteDefinition).title, pagePath: "/" },
    ]);
  });

  it("reads the draft, so a page the owner just added is listed", () => {
    const draft = withHomeSections(emptySite, [
      ...homePage(emptySite).sections,
      contactFormSection("section_contact_form"),
    ]);
    const [row] = siteFormsOverview(draft, installedPublicForms, {
      contact: 2,
    });
    expect(row!.placements).toEqual([
      { pageTitle: homePage(draft).title, pagePath: "/" },
    ]);
    expect(row!.messageCount).toBe(2);
  });
});
