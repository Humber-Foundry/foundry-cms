import { describe, expect, it } from "vitest";

import { installedPublicForms } from "../foundry/public-forms";
import { publicFormPublicStatus } from "./public-form-public-status";

const contact = installedPublicForms.find((form) => form.id === "contact");

const complete = {
  FOUNDRY_DB: {},
  FOUNDRY_FORM_RATE_LIMITER: {},
  FOUNDRY_CANONICAL_ORIGIN: "https://example.test",
  FOUNDRY_TURNSTILE_SITE_KEY: "0xSITEKEY",
  FOUNDRY_TURNSTILE_SECRET: "0xSECRET",
};

describe("what a public form block is told before a visitor types", () => {
  it("says the form works and names the key the widget needs", () => {
    expect(publicFormPublicStatus(contact, complete)).toEqual({
      available: true,
      schemaVersion: "1.0.0",
      turnstileSiteKey: "0xSITEKEY",
    });
  });

  it("says a form this site does not declare does not work", () => {
    expect(publicFormPublicStatus(undefined, complete)).toEqual({
      available: false,
      schemaVersion: null,
      turnstileSiteKey: null,
    });
  });

  it.each([
    "FOUNDRY_DB",
    "FOUNDRY_FORM_RATE_LIMITER",
    "FOUNDRY_CANONICAL_ORIGIN",
    "FOUNDRY_TURNSTILE_SITE_KEY",
    "FOUNDRY_TURNSTILE_SECRET",
  ])("says the form does not work without %s", (setting) => {
    const partial: Record<string, unknown> = { ...complete };
    delete partial[setting];
    expect(publicFormPublicStatus(contact, partial)).toEqual({
      available: false,
      schemaVersion: null,
      turnstileSiteKey: null,
    });
  });

  it("names no setting and no secret value", () => {
    const status = publicFormPublicStatus(contact, {
      ...complete,
      FOUNDRY_TURNSTILE_SECRET: "the-secret-value",
    });
    expect(JSON.stringify(status)).not.toContain("the-secret-value");
    expect(JSON.stringify(status)).not.toContain("FOUNDRY_");
  });
});
