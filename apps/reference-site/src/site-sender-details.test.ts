import { describe, expect, it } from "vitest";

import type { HumanAccessEnvironment } from "./human-access-configuration";
import {
  effectiveSenderDetails,
  environmentWithSenderDetails,
  readSenderDetails,
  senderDetailProblems,
  senderDetailsFromEnvironment,
  senderDetailsStateSentence,
  type SiteSenderDetails,
} from "./site-sender-details";

const installedEnvironment: HumanAccessEnvironment = {
  FOUNDRY_CAMPAIGN_SENDER_IDENTITY_ID: "sender_primary",
  FOUNDRY_CAMPAIGN_LEGAL_NAME: "Installed Name",
  FOUNDRY_CAMPAIGN_POSTAL_ADDRESS: "1 Installed Street",
  FOUNDRY_CAMPAIGN_CONTACT_URL: "https://installed.example/contact",
  FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL:
    "https://installed.example/newsletter/unsubscribe",
};

function stored(
  overrides: Partial<SiteSenderDetails> = {},
): SiteSenderDetails {
  return {
    legalName: "",
    postalAddress: "",
    contactUrl: "",
    unsubscribeUrl: "",
    senderIdentityId: "",
    ...overrides,
  };
}

describe("sender details", () => {
  it("reads the installation's own settings when nothing is stored", () => {
    expect(effectiveSenderDetails(installedEnvironment, null)).toEqual(
      senderDetailsFromEnvironment(installedEnvironment),
    );
    expect(
      environmentWithSenderDetails(installedEnvironment, null),
    ).toBe(installedEnvironment);
  });

  it("lets a stored value win over the setting of the same name", () => {
    const details = effectiveSenderDetails(
      installedEnvironment,
      stored({ legalName: "Saved Name" }),
    );

    expect(details.legalName).toBe("Saved Name");
    // The four values nobody saved still come from the installation.
    expect(details.postalAddress).toBe("1 Installed Street");
    expect(details.contactUrl).toBe("https://installed.example/contact");
    expect(details.unsubscribeUrl).toBe(
      "https://installed.example/newsletter/unsubscribe",
    );
    expect(details.senderIdentityId).toBe("sender_primary");
  });

  it("hands the campaign reader an environment with the stored values in it", () => {
    const applied = environmentWithSenderDetails(
      installedEnvironment,
      stored({ postalAddress: "2 Saved Road" }),
    );

    expect(applied.FOUNDRY_CAMPAIGN_POSTAL_ADDRESS).toBe("2 Saved Road");
    expect(applied.FOUNDRY_CAMPAIGN_LEGAL_NAME).toBe("Installed Name");
  });

  it("keeps reading the installation's settings when the store holds nothing", () => {
    const details = effectiveSenderDetails({}, stored());

    expect(details).toEqual({
      legalName: "",
      postalAddress: "",
      contactUrl: "",
      unsubscribeUrl: "",
      senderIdentityId: "",
    });
  });

  it("names every value that is still missing", () => {
    const problems = senderDetailProblems(
      stored({ contactUrl: "https://example.test/contact" }),
    );

    expect(problems.map((problem) => problem.field)).toEqual([
      "legalName",
      "postalAddress",
      "unsubscribeUrl",
    ]);
    expect(problems[0]!.message).toContain("Add the name");
  });

  it("refuses a contact or unsubscribe address that is not absolute", () => {
    const problems = senderDetailProblems(
      stored({
        legalName: "Saved Name",
        postalAddress: "2 Saved Road",
        contactUrl: "/contact",
        unsubscribeUrl: "http://example.test/stop",
      }),
    );

    expect(problems.map((problem) => problem.field)).toEqual([
      "contactUrl",
      "unsubscribeUrl",
    ]);
  });

  it("accepts an empty field whose value the installation already holds", () => {
    // The Owner changes only the unsubscribe address. The name, the postal
    // address and the contact address are left empty, which means "keep what
    // the installation already uses", so the save must not be refused.
    const typed = stored({ unsubscribeUrl: "https://saved.example/stop" });

    expect(senderDetailProblems(typed).length).toBeGreaterThan(0);
    expect(
      senderDetailProblems(effectiveSenderDetails(installedEnvironment, typed)),
    ).toEqual([]);
  });

  it("still refuses an empty field the installation has no value for", () => {
    const withoutName = {
      ...installedEnvironment,
      FOUNDRY_CAMPAIGN_LEGAL_NAME: "",
    };
    const problems = senderDetailProblems(
      effectiveSenderDetails(withoutName, stored({ postalAddress: "2 Saved Road" })),
    );

    expect(problems.map((problem) => problem.field)).toEqual(["legalName"]);
  });

  it("writes one plain sentence that names what is missing", () => {
    expect(senderDetailsStateSentence([])).toBe(
      "Your sender details are set. Every email carries them at the bottom.",
    );
    expect(
      senderDetailsStateSentence(senderDetailProblems(stored())),
    ).toContain("Email cannot be sent yet. Add the name");
  });

  it("accepts a full set", () => {
    expect(
      senderDetailProblems(
        stored({
          legalName: "Saved Name",
          postalAddress: "2 Saved Road",
          contactUrl: "https://example.test/contact",
          unsubscribeUrl: "https://example.test/stop",
          senderIdentityId: "sender_primary",
        }),
      ),
    ).toEqual([]);
  });

  it("reads only the five values out of a request, as trimmed strings", () => {
    expect(
      readSenderDetails({
        legalName: "  Saved Name  ",
        postalAddress: 12,
        surprise: "ignored",
      }),
    ).toEqual({
      legalName: "Saved Name",
      postalAddress: "",
      contactUrl: "",
      unsubscribeUrl: "",
      senderIdentityId: "",
    });
    expect(readSenderDetails("not an object")).toBeNull();
  });
});
