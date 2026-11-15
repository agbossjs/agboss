/**
 * #944 AC2: on the days the clocks change a working-hour deadline is exactly the working time asked,
 * never an hour more or less. The rule is pointwise: an instant is working time when its local
 * wall-clock time, on its local date, lies in `hours` and in no `break`; working time between two
 * instants is the real elapsed time of the working instants between them. Every case states its
 * UTC instants by hand; the property test counts minutes against an independent `Intl` oracle.
 */
import { describe, expect, it } from "vitest";
import { Weekday, type WorkingWeekOptions } from "../../src/index.js";
import { localDateAt, offsetAt } from "../../src/calendar/time-zones.js";
import { after, ALL_DAYS, HOUR, MINUTE, week } from "./helpers.js";

const day = (
  zone: string,
  hours: WorkingWeekOptions["hours"],
  rest: Partial<WorkingWeekOptions> = {},
) => week({ timeZone: zone, days: ALL_DAYS, hours, ...rest });

/**
 * One transition, by hand: the zone, the shift the grid works (local `from`–`to`), where the working
 * instants lie (UTC, as the real stretches `[start, end)` they cover) and their real length.
 */
interface Transition {
  readonly name: string;
  readonly zone: string;
  readonly shift: { from: string; to: string };
  /** The UTC instant the clocks change. */
  readonly at: string;
  readonly offsets: readonly [number, number];
  readonly start: string;
  readonly end: string;
  readonly hours: number;
}

const TRANSITIONS: readonly Transition[] = [
  {
    name: "Berlin 2026-03-29 spring forward",
    zone: "Europe/Berlin",
    shift: { from: "01:00", to: "04:00" },
    at: "2026-03-29T01:00:00.000Z",
    offsets: [1, 2],
    start: "2026-03-29T00:00:00.000Z",
    end: "2026-03-29T02:00:00.000Z",
    hours: 2,
  },
  {
    name: "Berlin 2026-10-25 fall back",
    zone: "Europe/Berlin",
    shift: { from: "01:00", to: "04:00" },
    at: "2026-10-25T01:00:00.000Z",
    offsets: [2, 1],
    start: "2026-10-24T23:00:00.000Z",
    end: "2026-10-25T03:00:00.000Z",
    hours: 4,
  },
  {
    name: "New York 2026-03-08 spring forward",
    zone: "America/New_York",
    shift: { from: "01:00", to: "04:00" },
    at: "2026-03-08T07:00:00.000Z",
    offsets: [-5, -4],
    start: "2026-03-08T06:00:00.000Z",
    end: "2026-03-08T08:00:00.000Z",
    hours: 2,
  },
  {
    name: "New York 2026-11-01 fall back",
    zone: "America/New_York",
    shift: { from: "01:00", to: "04:00" },
    at: "2026-11-01T06:00:00.000Z",
    offsets: [-4, -5],
    start: "2026-11-01T05:00:00.000Z",
    end: "2026-11-01T09:00:00.000Z",
    hours: 4,
  },
  {
    name: "Tel Aviv 2026-03-27 spring forward",
    zone: "Asia/Jerusalem",
    shift: { from: "01:00", to: "04:00" },
    at: "2026-03-27T00:00:00.000Z",
    offsets: [2, 3],
    start: "2026-03-26T23:00:00.000Z",
    end: "2026-03-27T01:00:00.000Z",
    hours: 2,
  },
  {
    name: "Tel Aviv 2026-10-25 fall back",
    zone: "Asia/Jerusalem",
    shift: { from: "00:00", to: "03:00" },
    at: "2026-10-24T23:00:00.000Z",
    offsets: [3, 2],
    start: "2026-10-24T21:00:00.000Z",
    end: "2026-10-25T01:00:00.000Z",
    hours: 4,
  },
  {
    // DST ends first Sunday of April at 02:00 (+11:00) → 01:30 (+10:30): a 30-minute change
    name: "Lord Howe 2026-04-05 fall back (30 minutes)",
    zone: "Australia/Lord_Howe",
    shift: { from: "01:00", to: "03:00" },
    at: "2026-04-04T15:00:00.000Z",
    offsets: [11, 10.5],
    start: "2026-04-04T14:00:00.000Z",
    end: "2026-04-04T16:30:00.000Z",
    hours: 2.5,
  },
  {
    // DST starts first Sunday of October at 02:00 (+10:30) → 02:30 (+11:00)
    name: "Lord Howe 2026-10-04 spring forward (30 minutes)",
    zone: "Australia/Lord_Howe",
    shift: { from: "01:00", to: "03:00" },
    at: "2026-10-03T15:30:00.000Z",
    offsets: [10.5, 11],
    start: "2026-10-03T14:30:00.000Z",
    end: "2026-10-03T16:00:00.000Z",
    hours: 1.5,
  },
];

describe("#944 AC2: the clock changes", () => {
  it.each(TRANSITIONS)("AC2: $name — the zone's offsets are what the cases assume", (one) => {
    const at = Date.parse(one.at);
    expect(offsetAt(one.zone, at - 1000) / HOUR).toBe(one.offsets[0]);
    expect(offsetAt(one.zone, at) / HOUR).toBe(one.offsets[1]);
  });

  it.each(TRANSITIONS)(
    "AC2: $name — an interval containing the transition counts its real length",
    async (one) => {
      const grid = day(one.zone, [one.shift]);
      const real = one.hours * HOUR;
      expect(await after(grid, one.start, real)).toBe(one.end);
      // one minute short: still inside; the minute before the end is working time
      expect(await after(grid, one.start, real - MINUTE)).toBe(
        new Date(Date.parse(one.end) - MINUTE).toISOString(),
      );
    },
  );

  it.each(TRANSITIONS)(
    "AC2: $name — the same 2 working hours on the day before and after are 2 real hours",
    async (one) => {
      const grid = day(one.zone, [one.shift]);
      const [before, afterShift] = one.offsets;
      // the shift starts at the same local time on the neighbouring days: 24 h away, by that day's offset
      const dayBefore = Date.parse(one.start) - 24 * HOUR;
      const dayAfter = Date.parse(one.start) + 24 * HOUR + (before - afterShift) * HOUR;
      for (const start of [dayBefore, dayAfter]) {
        expect(await after(grid, new Date(start).toISOString(), 2 * HOUR)).toBe(
          new Date(start + 2 * HOUR).toISOString(),
        );
      }
    },
  );

  it("AC2: a zone without DST: a shift is its plain length", async () => {
    const grid = day("Asia/Kolkata", [{ from: "01:00", to: "04:00" }]);
    // 01:00 IST (+5:30) = 19:30Z the day before
    expect(await after(grid, "2026-03-29T19:30:00.000Z", 3 * HOUR)).toBe(
      "2026-03-29T22:30:00.000Z",
    );
  });

  it("AC2: Berlin 2026-03-29: a gap inside hours has no working instants (that day has one hour less)", async () => {
    // hours 02:00–04:00 local: 02:00–03:00 does not exist; 03:00–04:00 CEST = [01:00Z, 02:00Z)
    const grid = day("Europe/Berlin", [{ from: "02:00", to: "04:00" }]);
    expect(await after(grid, "2026-03-29T00:00:00.000Z", HOUR)).toBe("2026-03-29T02:00:00.000Z");
    // 90 min: the next day's 02:00–04:00 CEST = [00:00Z, 02:00Z) gives the other 30 min
    expect(await after(grid, "2026-03-29T00:00:00.000Z", 90 * MINUTE)).toBe(
      "2026-03-30T00:30:00.000Z",
    );
  });

  it("AC2: New York 2026-11-01: a shift 01:30–04:00 is working on [05:30Z, 06:00Z) ∪ [06:30Z, 09:00Z): 3 h", async () => {
    const grid = day("America/New_York", [{ from: "01:30", to: "04:00" }]);
    // 01:30–01:59 EDT, then 01:30–03:59 EST
    expect(await after(grid, "2026-11-01T05:00:00.000Z", 30 * MINUTE)).toBe(
      "2026-11-01T06:00:00.000Z",
    );
    expect(await after(grid, "2026-11-01T06:00:00.000Z", 30 * MINUTE)).toBe(
      "2026-11-01T07:00:00.000Z",
    );
    expect(await after(grid, "2026-11-01T05:00:00.000Z", 3 * HOUR)).toBe(
      "2026-11-01T09:00:00.000Z",
    );
  });

  it("AC2: a break inside the fall-back overlap counts as two breaks, the shift's working time is exact", async () => {
    // 00:00–06:00 with a break 01:15–01:45 on New York's 2026-11-01: 7 real hours, minus two 30-min breaks
    const grid = day("America/New_York", [{ from: "00:00", to: "06:00" }], {
      breaks: [{ from: "01:15", to: "01:45" }],
    });
    // 00:00 EDT = 04:00Z; 06:00 EST = 11:00Z
    expect(await after(grid, "2026-11-01T04:00:00.000Z", 6 * HOUR)).toBe(
      "2026-11-01T11:00:00.000Z",
    );
    // the two breaks: [05:15Z, 05:45Z) and [06:15Z, 06:45Z)
    expect(await after(grid, "2026-11-01T05:15:00.000Z", MINUTE)).toBe("2026-11-01T05:46:00.000Z");
    expect(await after(grid, "2026-11-01T06:15:00.000Z", MINUTE)).toBe("2026-11-01T06:46:00.000Z");
    expect(await after(grid, "2026-11-01T05:00:00.000Z", 30 * MINUTE)).toBe(
      "2026-11-01T06:00:00.000Z",
    );
  });

  it("AC2: a 00:00–06:00 shift on the fall-back day is 7 real hours", async () => {
    const grid = day("America/New_York", [{ from: "00:00", to: "06:00" }]);
    expect(await after(grid, "2026-11-01T04:00:00.000Z", 7 * HOUR)).toBe(
      "2026-11-01T11:00:00.000Z",
    );
  });

  it("AC2: two hours intervals meeting inside the overlap never overlap in UTC", async () => {
    const split = day("America/New_York", [
      { from: "00:00", to: "01:30" },
      { from: "01:30", to: "06:00" },
    ]);
    const whole = day("America/New_York", [{ from: "00:00", to: "06:00" }]);
    for (const minutes of [30, 60, 90, 150, 300, 420]) {
      const from = "2026-11-01T04:00:00.000Z";
      expect(await after(split, from, minutes * MINUTE)).toBe(
        await after(whole, from, minutes * MINUTE),
      );
    }
  });

  it("AC2: 24:00 and the next day's 00:00 lose no minute, also in America/Havana", async () => {
    // Havana springs forward at 00:00 → 01:00 on 2026-03-08 (05:00Z): that local midnight never exists
    const night = day("America/Havana", [
      { from: "00:00", to: "06:00" },
      { from: "22:00", to: "24:00" },
    ]);
    // Saturday 22:00 CST (-5) = 03:00Z; Sunday 06:00 CDT (-4) = 10:00Z: 7 real hours, none lost
    expect(await after(night, "2026-03-08T03:00:00.000Z", 7 * HOUR)).toBe(
      "2026-03-08T10:00:00.000Z",
    );
    // and on a day with no change 22:00–06:00 is 8 hours
    expect(await after(night, "2026-03-10T02:00:00.000Z", 8 * HOUR)).toBe(
      "2026-03-10T10:00:00.000Z",
    );
  });

  it("AC2: the zone's formatter is made with hourCycle h23, never hour12 (V8's hour12: false gives hour 24 at midnight)", () => {
    const Original = Intl.DateTimeFormat;
    const made: (Intl.DateTimeFormatOptions | undefined)[] = [];
    class Recording extends Original {
      constructor(locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
        super(locales, options);
        made.push(options);
      }
    }
    Intl.DateTimeFormat = Recording as typeof Intl.DateTimeFormat;
    try {
      // a zone no other test has asked for: its formatter is made now
      offsetAt("Pacific/Auckland", Date.parse("2026-06-09T22:00:00.000Z"));
    } finally {
      Intl.DateTimeFormat = Original;
    }
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ timeZone: "Pacific/Auckland", hourCycle: "h23" });
    expect(made[0]).not.toHaveProperty("hour12");
  });

  it("AC2: midnight is hour 0 under every locale (hourCycle h23)", () => {
    // Berlin 2026-06-10 00:00 CEST = 2026-06-09T22:00Z: an hour read as "24" would shift the offset by a day
    expect(offsetAt("Europe/Berlin", Date.parse("2026-06-09T22:00:00.000Z"))).toBe(2 * HOUR);
    expect(localDateAt("Europe/Berlin", Date.parse("2026-06-09T22:00:00.000Z"))).toEqual({
      year: 2026,
      month: 6,
      day: 10,
    });
    expect(offsetAt("Asia/Tokyo", Date.parse("2026-06-09T15:00:00.000Z"))).toBe(9 * HOUR);
  });
});

/** A small deterministic generator: the property test is the same every run. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** The independent oracle: a real UTC minute is working time when its middle formats to a working local minute. */
function oracle(
  zone: string,
  options: {
    readonly days: readonly number[];
    readonly hours: readonly (readonly [number, number])[];
    readonly breaks: readonly (readonly [number, number])[];
    readonly holidays: readonly string[];
  },
): (minuteStart: number) => boolean {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return (minuteStart) => {
    const parts = format.formatToParts(new Date(minuteStart + 30_000));
    const part = (type: string): string => parts.find((one) => one.type === type)?.value ?? "";
    const date = `${part("year")}-${part("month")}-${part("day")}`;
    const weekday = names.indexOf(part("weekday"));
    const local = Number(part("hour")) * 60 + Number(part("minute"));
    const inside = (ranges: readonly (readonly [number, number])[]): boolean =>
      ranges.some(([from, to]) => local >= from && local < to);
    return (
      options.days.includes(weekday) &&
      !options.holidays.includes(date) &&
      inside(options.hours) &&
      !inside(options.breaks)
    );
  };
}

describe("#944 AC2: against an independent oracle", () => {
  const GRID = {
    days: [
      Weekday.Sunday,
      Weekday.Monday,
      Weekday.Tuesday,
      Weekday.Wednesday,
      Weekday.Thursday,
      Weekday.Friday,
    ],
    hours: [
      [0, 360],
      [480, 1020],
      [1320, 1440],
    ] as const,
    breaks: [
      [75, 105],
      [720, 780],
    ] as const,
  };
  const options: WorkingWeekOptions = {
    timeZone: "UTC",
    days: GRID.days,
    hours: [
      { from: "00:00", to: "06:00" },
      { from: "08:00", to: "17:00" },
      { from: "22:00", to: "24:00" },
    ],
    breaks: [
      { from: "01:15", to: "01:45" },
      { from: "12:00", to: "13:00" },
    ],
    holidays: [],
  };
  const DATES: readonly (readonly [string, string])[] = [
    ["Europe/Berlin", "2026-03-29T01:00:00.000Z"],
    ["Europe/Berlin", "2026-10-25T01:00:00.000Z"],
    ["America/New_York", "2026-03-08T07:00:00.000Z"],
    ["America/New_York", "2026-11-01T06:00:00.000Z"],
    ["Asia/Jerusalem", "2026-03-27T00:00:00.000Z"],
    ["Asia/Jerusalem", "2026-10-24T23:00:00.000Z"],
    ["Australia/Lord_Howe", "2026-04-04T15:00:00.000Z"],
    ["Australia/Lord_Howe", "2026-10-03T15:30:00.000Z"],
    ["Asia/Kolkata", "2026-03-29T00:00:00.000Z"],
  ];

  it.each(DATES)(
    "AC2: %s around %s — k working minutes after t contain exactly k working minutes, the last instant working",
    async (zone, transition) => {
      const grid = week({ ...options, timeZone: zone, holidays: ["2026-04-01"] });
      const isWorking = oracle(zone, {
        ...GRID,
        days: GRID.days,
        hours: GRID.hours,
        breaks: GRID.breaks,
        holidays: ["2026-04-01"],
      });
      const random = generator(Date.parse(transition) % 1_000_003);
      for (let round = 0; round < 40; round += 1) {
        const offsetMinutes = Math.floor((random() * 2 - 1) * 3 * 24 * 60);
        const t = Date.parse(transition) + offsetMinutes * MINUTE;
        const k = 1 + Math.floor(random() * 600);
        const end = Date.parse(await after(grid, new Date(t).toISOString(), k * MINUTE));
        let counted = 0;
        for (let minute = t; minute < end; minute += MINUTE) if (isWorking(minute)) counted += 1;
        expect({ zone, t: new Date(t).toISOString(), k, counted }).toEqual({
          zone,
          t: new Date(t).toISOString(),
          k,
          counted: k,
        });
        // the deadline is the end of the last working minute
        expect(isWorking(end - MINUTE)).toBe(true);
      }
    },
  );

  it("AC2: the oracle itself rejects a plain wall-clock addition (it is not a tautology)", () => {
    // plain addition from 06:30Z on Berlin's fall-back morning: counts fewer working minutes than asked
    const zone = "Europe/Berlin";
    const isWorking = oracle(zone, { ...GRID, holidays: [] });
    const t = Date.parse("2026-10-24T22:00:00.000Z");
    let counted = 0;
    for (let minute = t; minute < t + 600 * MINUTE; minute += MINUTE)
      if (isWorking(minute)) counted += 1;
    expect(counted).not.toBe(600);
  });

  it("the identity add(add(t, a), b) = add(t, a + b) holds (a sanity check only)", async () => {
    const grid = week({ ...options, timeZone: "America/New_York" });
    const t = "2026-11-01T03:30:00.000Z";
    const first = await after(grid, t, 95 * MINUTE);
    expect(await after(grid, first, 130 * MINUTE)).toBe(await after(grid, t, 225 * MINUTE));
  });
});
