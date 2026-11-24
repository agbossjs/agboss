/**
 * #1366: the settings of fenced effects and outbound calls are immutable once built.
 */
import { describe, expect, it } from "vitest";
import {
  FencedEffectSettings,
  OutboundCallSettings,
} from "../../../src/infrastructure/fenced-effect-settings.js";
import { hours } from "../../../src/units/index.js";

describe("#1366: the settings are frozen", () => {
  it("fenced-effect settings cannot be changed after they are built", () => {
    const settings = new FencedEffectSettings({ retention: hours(1) });

    expect(Object.isFrozen(settings)).toBe(true);
    expect(() => {
      (settings as { retention: number }).retention = hours(999);
    }).toThrow(TypeError);
    expect(settings.retention).toBe(hours(1));
  });

  it("outbound-call settings cannot be changed after they are built", () => {
    const settings = new OutboundCallSettings({ requiresMask: false });

    expect(Object.isFrozen(settings)).toBe(true);
    expect(() => {
      (settings as { requiresMask: boolean }).requiresMask = true;
    }).toThrow(TypeError);
    expect(settings.requiresMask).toBe(false);
  });
});
