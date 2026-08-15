import { describe, expect, it } from "vitest";

import { dashboardTimeZone, formatDashboardMoment } from "./dashboard-time";

describe("dashboard moment format", () => {
  it("reads as a date and time in the site's reporting time zone", () => {
    expect(formatDashboardMoment("2026-07-21T20:00:00.000Z")).toBe(
      "21 Jul 2026, 1:00 pm",
    );
  });

  it("uses one reporting time zone for the whole dashboard", () => {
    expect(dashboardTimeZone).toBe("America/Vancouver");
  });

  it("shows an unreadable timestamp as it was stored", () => {
    expect(formatDashboardMoment("not-a-time")).toBe("not-a-time");
  });
});
