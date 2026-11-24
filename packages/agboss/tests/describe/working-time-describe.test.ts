/**
 * #944: `agboss describe` says a role's deadline and reminder are working time — as data and on the
 * channel's line — and a tool's `expires in … of working time`.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { describedChannelsOf } from "../../src/describe/channels.js";
import { describedApplicationOf } from "../../src/describe/application.js";
import { describeAssembledApplication } from "../../src/describe/describe-application.js";
import { WorkingWeek } from "../../src/index.js";
import { hours, workingHours, workingMinutes } from "../../src/units/index.js";
import { workingApp } from "../flow/fixtures/working-time-app.js";
import { TEL_AVIV } from "../calendar/helpers.js";

describe("#944: describe shows working time", () => {
  it("a working deadline and reminder: the amounts in ms, flagged; the line says `of working time`", async () => {
    const { application } = workingApp("desc-working", {
      role: { expiresIn: workingHours(8), remindBefore: workingMinutes(30) },
      calendar: WorkingWeek.of(TEL_AVIV),
    });
    const assembled = await applicationOf(application);

    const channel = describedChannelsOf(assembled).find(
      (one) => one.name === "desc-working-question",
    );

    expect(channel).toMatchObject({
      expiresIn: 8 * 3_600_000,
      isExpiresInWorking: true,
      remindBefore: 30 * 60_000,
      isRemindBeforeWorking: true,
    });
    expect(describeAssembledApplication(assembled).join("\n")).toContain(
      "· expires in 8 h of working time · reminds 30 min of working time before",
    );
  });

  it("a plain deadline with a working reminder is not asked here (assembly refuses it); a plain role has no flags", async () => {
    const { application } = workingApp("desc-plain", {
      role: { expiresIn: hours(24), remindBefore: hours(2) },
    });
    const assembled = await applicationOf(application);

    const channel = describedChannelsOf(assembled).find(
      (one) => one.name === "desc-plain-question",
    );

    expect(channel).toMatchObject({ expiresIn: 24 * 3_600_000, remindBefore: 2 * 3_600_000 });
    expect(channel).not.toHaveProperty("isExpiresInWorking");
    expect(channel).not.toHaveProperty("isRemindBeforeWorking");
  });

  it("the calendar behind the application and behind a role is named", async () => {
    const { application } = workingApp("desc-cal", {
      role: { expiresIn: workingHours(8), workingCalendar: WorkingWeek.of(TEL_AVIV) },
      calendar: WorkingWeek.of(TEL_AVIV),
    });
    const assembled = await applicationOf(application);

    expect(describedApplicationOf(assembled)).toMatchObject({ workingCalendar: "working-week" });
    expect(describedChannelsOf(assembled)[0]).toMatchObject({ workingCalendar: "working-week" });
  });
});
