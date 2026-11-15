/**
 * #944 AC5 (assembly): a calendar with no working time at all is refused when the application
 * starts; a working duration needs a calendar (`[channel.working-time-without-calendar]`); a
 * working reminder before a plain deadline is refused on the role and on every override site
 * (`[channel.remind-before-working-without-working-expiry]`); `[channel.remind-before-invalid]`
 * compares the working amounts when both are working; a working step no longer than the role's
 * working reminder warns; `[name.kind-suffix]`, `[working-calendar.invalid]` for a class that is no
 * listed `@WorkingCalendar`.
 */
import { describe, expect, it } from "vitest";
import { createAppWith } from "../../src/application/create-app.js";
import { checkWorkflow } from "../../src/flow/analyse/analyse.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import type { Class } from "../../src/components/injection.js";
import { Injectable } from "../../src/components/decorators.js";
import {
  Weekday,
  WorkingCalendar,
  WorkingWeek,
  type WorkingCalendarHandler,
} from "../../src/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { hours, minutes, workingHours, workingMinutes } from "../../src/units/index.js";
import { workingApp, workingToolApp } from "../flow/fixtures/working-time-app.js";
import { ALL_DAYS, TEL_AVIV, WEEKDAYS } from "./helpers.js";

const assemble = (application: Class) =>
  createAppWith(application, { processEnv: {}, gateway: createScriptedGateway(new ScriptBook()) });

const violationsOf = async (
  application: Class,
): Promise<readonly { code: string; message: string }[]> => {
  const error: unknown = await assemble(application).catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(GraphRuleError);
  return (error as GraphRuleError).violations;
};

const codesOf = async (application: Class): Promise<readonly string[]> =>
  (await violationsOf(application)).map((one) => one.code);

const GRID = WorkingWeek.of(TEL_AVIV);

describe("#944 AC5: a grid with no working time is refused when the application starts", () => {
  const broken: readonly [string, Parameters<typeof WorkingWeek.of>[0]][] = [
    ["an unknown time zone", { ...TEL_AVIV, timeZone: "Mars/Olympus_Mons" }],
    ["a bare UTC offset is no IANA zone", { ...TEL_AVIV, timeZone: "+02:00" }],
    ["no days", { ...TEL_AVIV, days: [] }],
    ["a day that is no weekday", { ...TEL_AVIV, days: [7 as Weekday] }],
    ["no hours at all (no working minute in a week)", { ...TEL_AVIV, hours: [], breaks: [] }],
    ["from after to", { ...TEL_AVIV, hours: [{ from: "18:00", to: "09:00" }] }],
    ["from equal to to", { ...TEL_AVIV, hours: [{ from: "09:00", to: "09:00" }] }],
    [
      "an overnight interval 22:00–06:00",
      { ...TEL_AVIV, hours: [{ from: "22:00", to: "06:00" }], breaks: [] },
    ],
    [
      "overlapping hours",
      {
        ...TEL_AVIV,
        hours: [
          { from: "09:00", to: "13:00" },
          { from: "12:00", to: "18:00" },
        ],
        breaks: [],
      },
    ],
    ["a break outside the hours", { ...TEL_AVIV, breaks: [{ from: "18:30", to: "19:00" }] }],
    [
      "breaks that take every working minute out",
      {
        ...TEL_AVIV,
        hours: [{ from: "09:00", to: "10:00" }],
        breaks: [{ from: "09:00", to: "10:00" }],
      },
    ],
    ["a malformed time", { ...TEL_AVIV, hours: [{ from: "9:00", to: "18:00" }] }],
    ["24:00 as a start", { ...TEL_AVIV, hours: [{ from: "24:00", to: "24:00" }], breaks: [] }],
    ["an hour past 24", { ...TEL_AVIV, hours: [{ from: "09:00", to: "25:00" }] }],
    ["a holiday that is no date", { ...TEL_AVIV, holidays: ["2026-02-30"] }],
    ["a holiday in another format", { ...TEL_AVIV, holidays: ["25/12/2026"] }],
  ];

  it.each(broken)(
    "AC5: %s → [working-calendar.invalid] naming the application",
    async (_label, options) => {
      const { application } = workingApp(
        `grid${String(broken.findIndex((one) => one[1] === options))}`,
        {
          role: { expiresIn: workingHours(2) },
          calendar: WorkingWeek.of(options),
        },
      );

      const found = await violationsOf(application);

      // a bad grid may break several rules at once: every violation is this one, naming the application
      expect(found.length).toBeGreaterThan(0);
      expect(new Set(found.map((one) => one.code))).toEqual(new Set(["working-calendar.invalid"]));
      expect(found[0]?.message).toContain("-application");
    },
  );

  it("a valid grid assembles, 24:00 as an end, overlapping breaks aside", async () => {
    const { application } = workingApp("grid-ok", {
      role: { expiresIn: workingHours(2) },
      calendar: WorkingWeek.of({
        timeZone: "America/Havana",
        days: ALL_DAYS,
        hours: [
          { from: "00:00", to: "06:00" },
          { from: "22:00", to: "24:00" },
        ],
        holidays: ["2026-12-25"],
      }),
    });
    const app = await assemble(application);
    expect(app.warnings.filter((one) => one.includes("working"))).toEqual([]);
    await app.close();
  });

  it("a role's own grid is checked too", async () => {
    const { application } = workingApp("role-grid", {
      role: {
        expiresIn: workingHours(2),
        workingCalendar: WorkingWeek.of({ ...TEL_AVIV, days: [] }),
      },
    });
    expect(await codesOf(application)).toEqual(["working-calendar.invalid"]);
  });
});

describe("#944: a custom calendar class", () => {
  it("[working-calendar.invalid]: a class without @WorkingCalendar, without addWorkingTime, or not listed", async () => {
    class Bare implements WorkingCalendarHandler {
      addWorkingTime(): Date {
        return new Date(0);
      }
    }
    // untyped (JS) code: a decorated class whose function is gone
    @WorkingCalendar({ name: "no-function-working-calendar" })
    class NoFunction implements WorkingCalendarHandler {
      addWorkingTime(): Date {
        return new Date(0);
      }
    }
    Reflect.deleteProperty(NoFunction.prototype, "addWorkingTime");
    @WorkingCalendar({ name: "unlisted-working-calendar" })
    class Unlisted implements WorkingCalendarHandler {
      addWorkingTime(): Date {
        return new Date(0);
      }
    }

    const bare = workingApp("cal-bare", {
      role: { expiresIn: workingHours(2) },
      calendar: Bare,
      providers: [Bare],
    });
    const noFunction = workingApp("cal-nofn", {
      role: { expiresIn: workingHours(2) },
      calendar: NoFunction,
      providers: [NoFunction],
    });
    const unlisted = workingApp("cal-unlisted", {
      role: { expiresIn: workingHours(2) },
      calendar: Unlisted,
    });

    expect((await violationsOf(bare.application))[0]?.message).toContain("no @WorkingCalendar");
    expect((await violationsOf(noFunction.application))[0]?.message).toContain("addWorkingTime");
    const [listed] = await violationsOf(unlisted.application);
    expect(listed).toMatchObject({ code: "working-calendar.invalid" });
    expect(listed?.message).toContain("providers");
  });

  it("[name.kind-suffix]: a name that does not end with -working-calendar", async () => {
    @WorkingCalendar({ name: "holidays-calendar" })
    class Misnamed implements WorkingCalendarHandler {
      addWorkingTime(): Date {
        return new Date(0);
      }
    }
    const { application } = workingApp("cal-name", {
      role: { expiresIn: workingHours(2) },
      calendar: Misnamed,
      providers: [Misnamed],
    });

    const found = await violationsOf(application);

    expect(found).toEqual([expect.objectContaining({ code: "name.kind-suffix" })]);
    expect(found[0]?.message).toContain("holidays-calendar-working-calendar");
  });

  it("a listed @WorkingCalendar class with its dependencies assembles (the container creates it)", async () => {
    @Injectable()
    class Table {}
    @WorkingCalendar({ name: "table-working-calendar", deps: [Table] })
    class FromTable implements WorkingCalendarHandler {
      constructor(readonly table: Table) {}
      addWorkingTime(): Date {
        return new Date(0);
      }
    }
    const { application } = workingApp("cal-ok", {
      role: { expiresIn: workingHours(2) },
      calendar: FromTable,
      providers: [Table, FromTable],
    });
    const app = await assemble(application);
    expect(app.resolve(FromTable).table).toBeInstanceOf(Table);
    await app.close();
  });

  it("a role names a custom calendar class: the same rules", async () => {
    @WorkingCalendar({ name: "role-working-calendar" })
    class RoleCalendar implements WorkingCalendarHandler {
      addWorkingTime(): Date {
        return new Date(0);
      }
    }
    const missing = workingApp("cal-role-missing", {
      role: { expiresIn: workingHours(2), workingCalendar: RoleCalendar },
    });
    expect((await violationsOf(missing.application))[0]).toMatchObject({
      code: "working-calendar.invalid",
    });
    const listed = workingApp("cal-role-ok", {
      role: { expiresIn: workingHours(2), workingCalendar: RoleCalendar },
      providers: [RoleCalendar],
    });
    const app = await assemble(listed.application);
    await app.close();
  });
});

describe("#944: [channel.working-time-without-calendar]", () => {
  it("a working expiresIn or remindBefore on a role with no calendar anywhere", async () => {
    for (const [index, role] of [
      { expiresIn: workingHours(2) },
      { expiresIn: hours(4), remindBefore: workingMinutes(10) },
    ].entries()) {
      const { application } = workingApp(`nocal${String(index)}`, { role });
      const found = await violationsOf(application);
      expect(found.map((one) => one.code)).toContain("channel.working-time-without-calendar");
    }
  });

  it("a step's working expiresIn over a plain role with no calendar", async () => {
    const { application } = workingApp("nocal-step", {
      role: { expiresIn: hours(24) },
      step: workingHours(4),
    });
    expect(await codesOf(application)).toEqual(["channel.working-time-without-calendar"]);
  });

  it("a tool's working expiresIn with no calendar", async () => {
    const { application } = workingToolApp("nocal-tool", {
      role: { expiresIn: hours(24) },
      toolExpiresIn: workingHours(4),
    });
    expect(await codesOf(application)).toEqual(["channel.working-time-without-calendar"]);
  });

  it("the application's calendar satisfies it; so does the role's own", async () => {
    for (const [index, config] of [
      { role: { expiresIn: workingHours(2) }, calendar: GRID },
      { role: { expiresIn: workingHours(2), workingCalendar: GRID } },
      { role: { expiresIn: hours(24) }, step: workingHours(4), calendar: GRID },
    ].entries()) {
      const { application } = workingApp(`withcal${String(index)}`, config);
      const app = await assemble(application);
      expect(app.warnings.filter((one) => one.includes("working"))).toEqual([]);
      await app.close();
    }
  });

  it("plain durations need none", async () => {
    const { application } = workingApp("plain-only", {
      role: { expiresIn: hours(24), remindBefore: hours(2) },
    });
    const app = await assemble(application);
    expect(app.warnings.filter((one) => one.includes("working"))).toEqual([]);
    await app.close();
  });
});

describe("#944: [channel.remind-before-working-without-working-expiry]", () => {
  it("on the role: working remindBefore with a plain expiresIn", async () => {
    const { application } = workingApp("mixed-role", {
      role: { expiresIn: hours(24), remindBefore: workingHours(1) },
      calendar: GRID,
    });
    const found = await violationsOf(application);
    expect(found).toEqual([
      expect.objectContaining({ code: "channel.remind-before-working-without-working-expiry" }),
    ]);
  });

  it("on a .toQuestion override: plain hours(4) over a role whose remindBefore is working", async () => {
    const { application } = workingApp("mixed-step", {
      role: { expiresIn: workingHours(8), remindBefore: workingHours(1) },
      step: hours(4),
      calendar: GRID,
    });
    expect(await codesOf(application)).toEqual([
      "channel.remind-before-working-without-working-expiry",
    ]);
  });

  it("on a @Tool override: plain hours(4) over a role whose remindBefore is working", async () => {
    const { application } = workingToolApp("mixed-tool", {
      role: { expiresIn: workingHours(8), remindBefore: workingHours(1) },
      toolExpiresIn: hours(4),
      calendar: GRID,
    });
    expect(await codesOf(application)).toEqual([
      "channel.remind-before-working-without-working-expiry",
    ]);
  });

  it("a working override of a working role, a working deadline with a plain reminder: valid", async () => {
    for (const [index, config] of [
      {
        role: { expiresIn: workingHours(8), remindBefore: workingHours(1) },
        step: workingHours(4),
        calendar: GRID,
      },
      { role: { expiresIn: workingHours(8), remindBefore: hours(1) }, calendar: GRID },
      { role: { remindBefore: workingHours(1) }, step: workingHours(4), calendar: GRID },
    ].entries()) {
      const { application } = workingApp(`valid-mix${String(index)}`, config);
      const app = await assemble(application);
      expect(app.warnings.filter((one) => one.includes("remind-before"))).toEqual([]);
      await app.close();
    }
  });
});

describe("#944: [channel.remind-before-invalid] compares working amounts when both are working", () => {
  it("working remindBefore not shorter than the working expiresIn", async () => {
    for (const [index, role] of [
      { expiresIn: workingHours(2), remindBefore: workingHours(2) },
      { expiresIn: workingHours(2), remindBefore: workingHours(3) },
      { expiresIn: workingHours(1), remindBefore: workingMinutes(60) },
    ].entries()) {
      const { application } = workingApp(`cmp${String(index)}`, { role, calendar: GRID });
      const found = await violationsOf(application);
      expect(found).toEqual([expect.objectContaining({ code: "channel.remind-before-invalid" })]);
      expect(found[0]?.message).toContain("of working time");
    }
  });

  it("a shorter working reminder is valid; a plain reminder longer than a working deadline's amount is not compared", async () => {
    for (const [index, role] of [
      { expiresIn: workingHours(2), remindBefore: workingMinutes(119) },
      { expiresIn: workingHours(2), remindBefore: hours(10) },
    ].entries()) {
      const { application } = workingApp(`cmp-ok${String(index)}`, { role, calendar: GRID });
      const app = await assemble(application);
      expect(app.warnings.filter((one) => one.includes("remind-before"))).toEqual([]);
      await app.close();
    }
  });

  it("a working duration shorter than seconds(1) is [channel.expires-in-invalid] like a plain one", async () => {
    const { application } = workingApp("short", {
      role: { expiresIn: workingMinutes(0.001) },
      calendar: GRID,
    });
    expect(await codesOf(application)).toEqual(["channel.expires-in-invalid"]);
  });
});

describe("#944: [channel.remind-before-exceeds-expiry] in working time", () => {
  const warningsOf = (workflow: Class, strict = false) => {
    const checked = checkWorkflow(workflow, { strict });
    return {
      errors: checked.errors.map((one) => one.code),
      warnings: checked.warnings.map((one) => one.code),
    };
  };

  it("a step override workingMinutes(30) on a role reminding workingHours(1): a warning, an error under strict", () => {
    const { workflow } = workingApp("warn-working", {
      role: { expiresIn: workingHours(8), remindBefore: workingHours(1) },
      step: workingMinutes(30),
      calendar: GRID,
    });
    expect(warningsOf(workflow)).toEqual({
      errors: [],
      warnings: ["channel.remind-before-exceeds-expiry"],
    });
    expect(warningsOf(workflow, true)).toEqual({
      errors: ["channel.remind-before-exceeds-expiry"],
      warnings: [],
    });
  });

  it("a tool override workingHours(1) on a role reminding workingHours(1): the same warning", () => {
    const { workflow } = workingToolApp("warn-tool", {
      role: { expiresIn: workingHours(8), remindBefore: workingHours(1) },
      toolExpiresIn: workingMinutes(60),
      calendar: GRID,
    });
    expect(warningsOf(workflow).warnings).toEqual(["channel.remind-before-exceeds-expiry"]);
  });

  it("a longer working step, or a plain step over working time, is not warned about here", () => {
    const longer = workingApp("warn-longer", {
      role: { expiresIn: workingHours(8), remindBefore: workingHours(1) },
      step: workingHours(2),
      calendar: GRID,
    });
    expect(warningsOf(longer.workflow, true)).toEqual({ errors: [], warnings: [] });
    // a plain 30-minute step against a working reminder is the other rule's: an error at assembly
    const plain = workingApp("warn-plain", {
      role: { expiresIn: workingHours(8), remindBefore: workingHours(1) },
      step: minutes(30),
      calendar: GRID,
    });
    expect(warningsOf(plain.workflow, true).warnings).toEqual([]);
  });
});

describe("#944: the other flow syntax stays plain", () => {
  it("a Weekday and the weekday lists are the documented numbers", () => {
    expect(Weekday.Sunday).toBe(0);
    expect(Weekday.Saturday).toBe(6);
    expect(WEEKDAYS).toHaveLength(5);
  });
});

describe("#944: a calendar class is a component like any other", () => {
  it("a dependency nobody provides fails at start, for the application's calendar and a role's", async () => {
    @Injectable()
    class Missing {}
    @WorkingCalendar({ name: "needy-working-calendar", deps: [Missing] })
    class Needy implements WorkingCalendarHandler {
      constructor(readonly table: Missing) {}
      addWorkingTime(): Date {
        return new Date(0);
      }
    }
    const appLevel = workingApp("needy-app", {
      role: { expiresIn: workingHours(2) },
      calendar: Needy,
      providers: [Needy],
    });
    const roleLevel = workingApp("needy-role", {
      role: { expiresIn: workingHours(2), workingCalendar: Needy },
      providers: [Needy],
    });
    for (const { application } of [appLevel, roleLevel]) {
      const error: unknown = await assemble(application).catch((thrown: unknown) => thrown);
      expect(String(error)).toContain("Missing");
    }
  });

  it("[working-calendar.duplicate-name]: two classes with one name", async () => {
    @WorkingCalendar({ name: "same-working-calendar" })
    class First implements WorkingCalendarHandler {
      addWorkingTime(): Date {
        return new Date(0);
      }
    }
    @WorkingCalendar({ name: "same-working-calendar" })
    class Second implements WorkingCalendarHandler {
      addWorkingTime(): Date {
        return new Date(0);
      }
    }
    const { application } = workingApp("dup-cal", {
      role: { expiresIn: workingHours(2), workingCalendar: Second },
      calendar: First,
      providers: [First, Second],
    });
    expect(await codesOf(application)).toEqual(["working-calendar.duplicate-name"]);
  });
});

describe("#944: a span the grid cannot reach in 25 years is refused at start", () => {
  const sparse = WorkingWeek.of({
    timeZone: "UTC",
    days: [Weekday.Monday],
    hours: [{ from: "09:00", to: "09:01" }],
  });

  it("on the role, on a step override, on a tool override", async () => {
    const role = workingApp("reach-role", {
      role: { expiresIn: workingHours(43_920) },
      calendar: sparse,
    });
    const step = workingApp("reach-step", {
      role: { expiresIn: hours(24) },
      step: workingHours(43_920),
      calendar: sparse,
    });
    const tool = workingToolApp("reach-tool", {
      role: { expiresIn: hours(24) },
      toolExpiresIn: workingHours(43_920),
      calendar: sparse,
    });
    for (const { application } of [role, step, tool]) {
      const found = await violationsOf(application);
      expect(found.map((one) => one.code)).toEqual(["working-calendar.invalid"]);
      expect(found[0]?.message).toContain("25 years");
    }
  });

  it("#1148: the holidays count: a span the bare grid reaches is refused once fifty of its Mondays are holidays", async () => {
    const monday = {
      timeZone: "UTC",
      days: [Weekday.Monday],
      hours: [{ from: "09:00", to: "10:00" }],
    } as const;
    const holidays = Array.from({ length: 50 }, (_, index) =>
      new Date(Date.UTC(2026, 0, 12 + 7 * index)).toISOString().slice(0, 10),
    );
    const bare = workingApp("reach-bare", {
      role: { expiresIn: workingHours(1307) },
      calendar: WorkingWeek.of(monday),
    });
    const closed = workingApp("reach-holidays", {
      role: { expiresIn: workingHours(1307) },
      calendar: WorkingWeek.of({ ...monday, holidays }),
    });

    await (await assemble(bare.application)).close();
    const found = await violationsOf(closed.application);
    expect(found.map((one) => one.code)).toEqual(["working-calendar.invalid"]);
    expect(found[0]?.message).toContain("25 years");
  });

  it("a reachable span on the same grid assembles", async () => {
    const { application } = workingApp("reach-ok", {
      role: { expiresIn: workingHours(1) },
      calendar: sparse,
    });
    const app = await assemble(application);
    expect(app.warnings.filter((one) => one.includes("working"))).toEqual([]);
    await app.close();
  });
});
