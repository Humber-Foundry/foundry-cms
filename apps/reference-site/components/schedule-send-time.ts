/**
 * Turn the date and time a person picked into the single instant a scheduled
 * send runs at.
 *
 * The person types a wall-clock time in their own time zone. A send needs one
 * exact UTC instant, and a day can hold a wall-clock time twice or not at all,
 * so the two cannot be the same value. This does that conversion in the
 * browser, where the person's zone is known.
 *
 * The server verifies every field of the result against its own calendar
 * before it activates a schedule, so nothing here is trusted. This exists to
 * let the screen refuse an impossible time in plain words instead of showing
 * the person a rejected command.
 */

/** The resolved time a schedule command carries. */
export type SendTime = Readonly<{
  localDateTime: string;
  ianaTimeZone: string;
  utcOffsetChoice: string;
  executeAtUtc: string;
  timeZoneDatabaseVersion: string;
}>;

export type ResolvedSendTime =
  | Readonly<{ outcome: "resolved"; time: SendTime }>
  | Readonly<{ outcome: "not_a_time" }>
  | Readonly<{ outcome: "unknown_time_zone" }>
  | Readonly<{ outcome: "no_such_time" }>
  | Readonly<{ outcome: "already_past" }>;

/**
 * The browser resolves a zone with its own copy of the time-zone rules and
 * does not publish that copy's version. The schedule records which calendar
 * resolved it, so this says plainly that the browser's calendar did. The
 * server checks the resulting instant against its own.
 */
const browserTimeZoneDatabaseVersion = "browser-icu";

const chosenDateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/u;

function civilParts(instant: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return Object.fromEntries(
    formatter
      .formatToParts(instant)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value]),
  ) as Record<string, string>;
}

function localDateTimeAt(instant: Date, timeZone: string): string {
  const parts = civilParts(instant, timeZone);
  return (
    `${parts.year}-${parts.month}-${parts.day}` +
    `T${parts.hour}:${parts.minute}:${parts.second}`
  );
}

/** How far the zone is from UTC at one instant, in minutes. */
function offsetMinutesAt(instant: Date, timeZone: string): number {
  const parts = civilParts(instant, timeZone);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

function offsetLabel(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  return `${sign}${hours}:${String(absolute % 60).padStart(2, "0")}`;
}

export function resolveSendTime({
  chosenDateTime,
  ianaTimeZone,
  now,
}: {
  /** What a date-and-time field holds, such as `2026-09-20T09:00`. */
  chosenDateTime: string;
  ianaTimeZone: string;
  now: Date;
}): ResolvedSendTime {
  if (!chosenDateTimePattern.test(chosenDateTime)) {
    return Object.freeze({ outcome: "not_a_time" as const });
  }
  const localDateTime =
    chosenDateTime.length === 16 ? `${chosenDateTime}:00` : chosenDateTime;
  const wallClock = Date.parse(`${localDateTime}Z`);
  if (!Number.isFinite(wallClock)) {
    return Object.freeze({ outcome: "not_a_time" as const });
  }
  let instant: Date;
  try {
    // The wall-clock reading is the instant shifted by the zone's offset, and
    // the offset itself depends on the instant. Two passes settle it: the
    // first uses the offset around the wall-clock reading, the second uses the
    // offset at the instant that produced.
    const firstPass = new Date(
      wallClock - offsetMinutesAt(new Date(wallClock), ianaTimeZone) * 60_000,
    );
    instant = new Date(
      wallClock - offsetMinutesAt(firstPass, ianaTimeZone) * 60_000,
    );
  } catch {
    return Object.freeze({ outcome: "unknown_time_zone" as const });
  }
  if (!Number.isFinite(instant.getTime())) {
    return Object.freeze({ outcome: "not_a_time" as const });
  }
  if (localDateTimeAt(instant, ianaTimeZone) !== localDateTime) {
    // The clocks jumped over this reading, so no instant shows it.
    return Object.freeze({ outcome: "no_such_time" as const });
  }
  if (instant.getTime() <= now.getTime()) {
    return Object.freeze({ outcome: "already_past" as const });
  }
  return Object.freeze({
    outcome: "resolved" as const,
    time: Object.freeze({
      localDateTime,
      ianaTimeZone,
      utcOffsetChoice: offsetLabel(offsetMinutesAt(instant, ianaTimeZone)),
      executeAtUtc: instant.toISOString(),
      timeZoneDatabaseVersion: browserTimeZoneDatabaseVersion,
    }),
  });
}

/** The time zone this browser is set to, falling back to UTC. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
