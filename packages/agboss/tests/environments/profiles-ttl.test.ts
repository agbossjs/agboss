/** #1324b: `ApplicationContext.profiles`, and `Ttl` from the root and `/units`. */
import { describe, expect, it } from "vitest";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import * as root from "../../src/index.js";
import * as units from "../../src/units/index.js";

const values = {
  name: "a-application",
  version: "1.0.0",
  instanceId: "i-1",
  startedAt: new Date(0),
} as const;

describe("#1324b: ApplicationContext.profiles", () => {
  it("is the profiles the instance runs with, frozen; none when none was given — and no environment on the context", () => {
    expect(applicationContextOf(values).profiles).toEqual([]);
    expect(applicationContextOf(values)).not.toHaveProperty("environment");
    expect(applicationContextOf(values)).not.toHaveProperty("environmentName");
    const layered = applicationContextOf({ ...values, profiles: ["prod", "economy"] });

    expect(layered.profiles).toEqual(["prod", "economy"]);
    expect(Object.isFrozen(layered.profiles)).toBe(true);
  });
});

describe("#1324b: Ttl", () => {
  it("is Forever and None, from the root and from /units", () => {
    expect(root.Ttl).toBe(units.Ttl);
    expect(units.Ttl.Forever).toBe("forever");
    expect(units.Ttl.None).toBe("none");
    expect(Object.keys(units.Ttl)).toEqual(["Forever", "None"]);
  });
});
