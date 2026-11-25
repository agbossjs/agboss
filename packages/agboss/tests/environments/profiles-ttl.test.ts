/** #1324b: `ApplicationContext.profiles`, and `Ttl` from the root and `/units`. */
import { describe, expect, it } from "vitest";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import * as root from "../../src/index.js";
import * as units from "../../src/units/index.js";

const values = {
  name: "a-application",
  version: "1.0.0",
  instanceId: "i-1",
  startedAt: new Date(0),
  environmentName: "prod",
  environment: NO_ENVIRONMENT_VALUES,
} as const;

describe("#1324b: ApplicationContext.profiles", () => {
  it("is the profiles the instance runs with, frozen; `[environmentName]` while the old name stands", () => {
    expect(applicationContextOf(values).profiles).toEqual(["prod"]);
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
