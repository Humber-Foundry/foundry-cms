import { describe, expect, it } from "vitest";

import {
  mediaAccessRefreshDelayMs,
  mediaAccessRequestBody,
  parseMediaCatalogGrant,
} from "./media-catalog-grant";

const grant = {
  assets: [{ assetId: "asset_hero" }],
  occurrences: [
    {
      occurrenceId: "occurrence_home_hero",
      revision: 1,
      assetId: "asset_hero",
      crop: null,
    },
  ],
  accessToken: "signed-media-access",
  accessTokenExpiresAt: 1_785_124_800,
};

describe("media access request", () => {
  it("asks for the catalog of one workspace", () => {
    expect(mediaAccessRequestBody("workspace_editor")).toBe(
      '{"operation":"access","workspaceId":"workspace_editor"}',
    );
  });
});

describe("media catalog grant", () => {
  it("reads a complete grant", () => {
    expect(parseMediaCatalogGrant(grant)).toEqual(grant);
  });

  it("refuses a grant that is not an object", () => {
    expect(() => parseMediaCatalogGrant(null)).toThrow(
      "media_access_grant_failed",
    );
    expect(() => parseMediaCatalogGrant("granted")).toThrow(
      "media_access_grant_failed",
    );
  });

  it("refuses a grant without a photo list", () => {
    expect(() => parseMediaCatalogGrant({ ...grant, assets: undefined })).toThrow(
      "media_access_grant_failed",
    );
  });

  it("refuses a grant without a place list", () => {
    expect(() =>
      parseMediaCatalogGrant({ ...grant, occurrences: "none" }),
    ).toThrow("media_access_grant_failed");
  });

  it("refuses a grant without an access token", () => {
    expect(() =>
      parseMediaCatalogGrant({ ...grant, accessToken: undefined }),
    ).toThrow("media_access_grant_failed");
  });

  it("refuses a grant without an expiry instant", () => {
    expect(() =>
      parseMediaCatalogGrant({ ...grant, accessTokenExpiresAt: "soon" }),
    ).toThrow("media_access_grant_failed");
  });
});

describe("media access refresh delay", () => {
  const now = 1_785_120_000_000;

  it("renews half a minute before the token expires", () => {
    expect(mediaAccessRefreshDelayMs(now / 1_000 + 300, now)).toBe(270_000);
  });

  it("never schedules a renewal sooner than one second", () => {
    expect(mediaAccessRefreshDelayMs(now / 1_000 + 5, now)).toBe(1_000);
  });

  it("renews at once when the token has already expired", () => {
    expect(mediaAccessRefreshDelayMs(now / 1_000 - 100, now)).toBe(1_000);
  });
});
