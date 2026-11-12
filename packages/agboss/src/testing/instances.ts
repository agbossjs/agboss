import type { MeterProvider } from "@opentelemetry/api";
import { ClockSkew } from "./clock-skew.js";
import type { TestWithOptions } from "./environment.js";
import { TestSetupError } from "./errors.js";

/** One instance of a test (#831): its own settings, `apps[i]`'s in `instances[i]`. */
export interface TestInstanceOptions {
  /**
   * The instance's clock skew (#533; default `ClockSkew.none`): its wall clock ahead or behind,
   * running fast or slow — while the stores decide by the test's clock, as by a database's own.
   */
  readonly clockSkew?: ClockSkew;
  /**
   * The instance's OpenTelemetry `MeterProvider` (#485; default none: no metrics on it): read it
   * with an in-memory reader, `await reader.collect()`.
   */
  readonly meterProvider?: MeterProvider;
}

/** The keys a `TestInstanceOptions` may have: another is a typo the test would silently ignore. */
const INSTANCE_OPTION_KEYS: ReadonlySet<string> = new Set(["clockSkew", "meterProvider"]);

/**
 * The test's instances, one entry each (#831): `instances` as a count of plain ones (a whole number
 * ≥ 1, default 1) or as given — a non-empty list of objects with no key but `clockSkew` and
 * `meterProvider`; anything else is a `TestSetupError`.
 */
export function testInstancesOf(options: TestWithOptions): readonly TestInstanceOptions[] {
  for (const removed of ["clockSkews", "meterProviders"])
    if (Reflect.get(options, removed) !== undefined)
      throw new TestSetupError({
        message: `${removed}: no such option (#831) — each instance's own settings are its entry: instances: [{ clockSkew, meterProvider }, …]`,
      });
  const instances: unknown = options.instances ?? 1;
  if (typeof instances === "number") {
    if (!Number.isInteger(instances) || instances < 1)
      throw new TestSetupError({ message: `instances: ${String(instances)} — a whole number ≥ 1` });
    return Array.from({ length: instances }, () => ({}));
  }
  if (!Array.isArray(instances) || instances.length === 0)
    throw new TestSetupError({
      message:
        "instances: a whole number ≥ 1, or a non-empty list of { clockSkew?, meterProvider? }",
    });
  return instances.map((instance: unknown, at) => {
    if (typeof instance !== "object" || instance === null)
      throw new TestSetupError({ message: `instances[${String(at)}]: not an object` });
    const unknown = Object.keys(instance).filter((key) => !INSTANCE_OPTION_KEYS.has(key));
    if (unknown.length > 0)
      throw new TestSetupError({
        message: `instances[${String(at)}]: ${unknown.join(", ")} — an instance takes clockSkew and meterProvider only`,
      });
    const { clockSkew } = instance as TestInstanceOptions;
    if (clockSkew !== undefined && !(clockSkew instanceof ClockSkew))
      throw new TestSetupError({
        message: `instances[${String(at)}].clockSkew: not a ClockSkew (ClockSkew.ahead(…), .behind(…), .drifting(…))`,
      });
    return instance;
  });
}
