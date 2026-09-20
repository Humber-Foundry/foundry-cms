import { describe, expect, it } from "vitest";

import { siteInitial } from "./site-display";

describe("siteInitial", () => {
  it("takes the first letter of the site name, capitalized", () => {
    expect(siteInitial("Harbour Yoga")).toBe("H");
    expect(siteInitial("lowercase site")).toBe("L");
  });

  it("skips leading whitespace", () => {
    expect(siteInitial("  Padded Name")).toBe("P");
  });

  it("keeps a non-letter first character as its own character", () => {
    expect(siteInitial("42 North Charters")).toBe("4");
  });

  it("falls back to F when the name is empty or blank", () => {
    expect(siteInitial("")).toBe("F");
    expect(siteInitial("   ")).toBe("F");
  });
});
