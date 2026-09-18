import { describe, expect, it } from "vitest";

import { resolveSendTime } from "./schedule-send-time";

const now = new Date("2026-09-18T12:00:00.000Z");

describe("schedule send time", () => {
  it("resolves a chosen date and time to one instant the server can verify", () => {
    const resolved = resolveSendTime({
      chosenDateTime: "2026-09-20T09:00",
      ianaTimeZone: "America/Vancouver",
      now,
    });

    expect(resolved).toEqual({
      outcome: "resolved",
      time: {
        localDateTime: "2026-09-20T09:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: "2026-09-20T16:00:00.000Z",
        timeZoneDatabaseVersion: "browser-icu",
      },
    });
  });

  it("keeps the chosen wall-clock time across a daylight-saving change", () => {
    // 01:30 happens twice when the clocks go back. The resolved instant must
    // still read 01:30 in the chosen zone, whichever occurrence is picked.
    const resolved = resolveSendTime({
      chosenDateTime: "2026-11-01T01:30",
      ianaTimeZone: "America/Vancouver",
      now,
    });

    expect(resolved.outcome).toBe("resolved");
    if (resolved.outcome !== "resolved") return;
    expect(resolved.time.localDateTime).toBe("2026-11-01T01:30:00");
    expect(["-07:00", "-08:00"]).toContain(resolved.time.utcOffsetChoice);
  });

  it("refuses a time that does not exist on that day", () => {
    // The clocks go forward at 02:00, so 02:30 never happens that morning.
    expect(
      resolveSendTime({
        chosenDateTime: "2026-03-08T02:30",
        ianaTimeZone: "America/Vancouver",
        now,
      }),
    ).toEqual({ outcome: "no_such_time" });
  });

  it("refuses a time that has already passed", () => {
    expect(
      resolveSendTime({
        chosenDateTime: "2026-09-18T00:00",
        ianaTimeZone: "UTC",
        now,
      }),
    ).toEqual({ outcome: "already_past" });
  });

  it("refuses an entry that is not a date and time", () => {
    expect(
      resolveSendTime({
        chosenDateTime: "",
        ianaTimeZone: "UTC",
        now,
      }),
    ).toEqual({ outcome: "not_a_time" });
    expect(
      resolveSendTime({
        chosenDateTime: "2026-09-20",
        ianaTimeZone: "UTC",
        now,
      }),
    ).toEqual({ outcome: "not_a_time" });
  });

  it("refuses a time zone the browser cannot read", () => {
    expect(
      resolveSendTime({
        chosenDateTime: "2026-09-20T09:00",
        ianaTimeZone: "Nowhere/Unreal",
        now,
      }),
    ).toEqual({ outcome: "unknown_time_zone" });
  });
});
