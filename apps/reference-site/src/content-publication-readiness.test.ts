import { describe, expect, it } from "vitest";

import {
  contentPublicationSettingNames,
  contentPublicationSetupGuide,
  listMissingContentPublicationSettings,
} from "./content-publication-readiness";
import type { HumanAccessEnvironment } from "./human-access-configuration";

const configuredEnvironment: HumanAccessEnvironment = Object.freeze({
  FOUNDRY_GITHUB_APP_ID: "123456",
  FOUNDRY_GITHUB_INSTALLATION_ID: "789012",
  FOUNDRY_GITHUB_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
  FOUNDRY_GITHUB_OWNER: "example-owner",
  FOUNDRY_GITHUB_REPOSITORY: "example-repository",
  FOUNDRY_PUBLIC_ORIGIN: "https://example.test",
  FOUNDRY_CLOUDFLARE_ACCOUNT_ID: "account-id",
  FOUNDRY_CLOUDFLARE_SCRIPT_TAG: "script-tag",
  FOUNDRY_CLOUDFLARE_SCRIPT_NAME: "script-name",
  FOUNDRY_CLOUDFLARE_BUILD_TRIGGER_ID: "trigger-id",
  FOUNDRY_CLOUDFLARE_API_TOKEN: "cloudflare-token",
  FOUNDRY_PUBLICATION_SIGNING_SECRET: "s".repeat(32),
});

function environmentWithout(
  name: keyof HumanAccessEnvironment,
): HumanAccessEnvironment {
  const { [name]: _removed, ...rest } = configuredEnvironment;
  return rest;
}

describe("content publication readiness settings", () => {
  it("reports nothing missing when every publishing setting is installed", () => {
    expect(
      listMissingContentPublicationSettings(configuredEnvironment),
    ).toEqual([]);
  });

  it("reports every publishing setting when none is installed", () => {
    expect(listMissingContentPublicationSettings({})).toEqual([
      ...contentPublicationSettingNames,
    ]);
  });

  it("names each absent setting one at a time", () => {
    for (const name of contentPublicationSettingNames) {
      expect(
        listMissingContentPublicationSettings(
          environmentWithout(name as keyof HumanAccessEnvironment),
        ),
      ).toEqual([name]);
    }
  });

  it("treats a blank setting as missing", () => {
    expect(
      listMissingContentPublicationSettings({
        ...configuredEnvironment,
        FOUNDRY_GITHUB_APP_ID: "   ",
      }),
    ).toEqual(["FOUNDRY_GITHUB_APP_ID"]);
  });

  it("rejects a public origin that is not an absolute https address", () => {
    expect(
      listMissingContentPublicationSettings({
        ...configuredEnvironment,
        FOUNDRY_PUBLIC_ORIGIN: "http://example.test",
      }),
    ).toEqual(["FOUNDRY_PUBLIC_ORIGIN"]);
    expect(
      listMissingContentPublicationSettings({
        ...configuredEnvironment,
        FOUNDRY_PUBLIC_ORIGIN: "not-a-url",
      }),
    ).toEqual(["FOUNDRY_PUBLIC_ORIGIN"]);
  });

  it("rejects a publication signing secret shorter than 32 bytes", () => {
    expect(
      listMissingContentPublicationSettings({
        ...configuredEnvironment,
        FOUNDRY_PUBLICATION_SIGNING_SECRET: "s".repeat(31),
      }),
    ).toEqual(["FOUNDRY_PUBLICATION_SIGNING_SECRET"]);
  });

  it("names the setup guide", () => {
    expect(contentPublicationSetupGuide).toBe(
      "docs/operations/github-publishing-readiness.md",
    );
  });
});
