import { describe, expect, it } from "vitest";

import { placeNameFor } from "./media-places";

describe("media places", () => {
  it("names the home page's two places", () => {
    expect(placeNameFor("occurrence_home_hero")).toBe("Top of the page");
    expect(placeNameFor("occurrence_home_detail")).toBe(
      "Further down the page",
    );
  });

  it("names any other page's places too", () => {
    // ADR-0026 widened an occurrence id to `occurrence_<page>_<slot>`, so the
    // slot at the end decides the name, not a fixed list of two ids.
    expect(placeNameFor("occurrence_page_about_hero")).toBe("Top of the page");
    expect(placeNameFor("occurrence_page_contact_detail")).toBe(
      "Further down the page",
    );
  });

  it("shows an unknown id rather than nothing", () => {
    expect(placeNameFor("occurrence_new_slot")).toBe("occurrence_new_slot");
  });
});
