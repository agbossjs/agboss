/**
 * #1366: the settings of fenced effects and outbound calls are immutable once built; a violation names the
 * application it is about (its `nodes`), for fenced effects and for outbound calls alike.
 */
import { describe, expect, it } from "vitest";
import {
  FencedEffectSettings,
  OutboundCallSettings,
  fencedEffectsViolations,
  outboundCallsViolations,
} from "../../src/infrastructure/fenced-effect-settings.js";
import { kilobytes, type Bytes } from "../../src/units/index.js";

describe("#1366: the settings are frozen", () => {
  it("fenced-effect settings cannot be changed after they are built", () => {
    const settings = new FencedEffectSettings({ maxResultSize: kilobytes(1) });

    expect(Object.isFrozen(settings)).toBe(true);
    expect(() => {
      (settings as { maxResultSize: Bytes }).maxResultSize = kilobytes(999);
    }).toThrow(TypeError);
    expect(settings.maxResultSize).toBe(kilobytes(1));
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

describe("#1366: a violation of the application's settings names the application", () => {
  it("a fenced-effects violation is about the application", () => {
    const found = fencedEffectsViolations("Shop", { maxResultSize: 0 as Bytes });

    expect(found).toHaveLength(1);
    expect(found[0]?.code).toBe("application.fenced-effects-invalid");
    expect(found[0]?.nodes).toEqual(["Shop"]);
  });

  it("an outbound-calls violation is about the application", () => {
    const found = outboundCallsViolations("Shop", { maxPayloadSize: -1 as Bytes });

    expect(found).toHaveLength(1);
    expect(found[0]?.code).toBe("application.outbound-calls-invalid");
    expect(found[0]?.nodes).toEqual(["Shop"]);
  });
});
