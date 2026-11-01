/**
 * #646 — the core's lazy loads in flight (`lazyLoad`, `loadsInFlight` in `infrastructure/clock.ts`):
 * what a test's `clock.advance` waits for before it moves the time.
 */
import { describe, expect, it } from "vitest";
import { lazyLoad, loadsInFlight } from "../../src/infrastructure/clock.js";

/** A load that settles when the test says so. */
function heldLoad<T>(): {
  readonly load: Promise<T>;
  readonly finish: (value: T) => void;
  readonly fail: (error: Error) => void;
} {
  let finish: (value: T) => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const load = new Promise<T>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  return { load, finish, fail };
}

describe("#646: lazyLoad keeps a load in flight until it settles", () => {
  it("returns the load as it is, in flight until it resolves", async () => {
    const before = loadsInFlight().length;
    const held = heldLoad<string>();

    const returned = lazyLoad(held.load);

    expect(returned).toBe(held.load);
    expect(loadsInFlight()).toHaveLength(before + 1);
    held.finish("module");
    expect(await returned).toBe("module");
    await Promise.all(loadsInFlight());
    expect(loadsInFlight()).toHaveLength(before);
  });

  it("a load that fails leaves the set too, its rejection its caller's", async () => {
    const before = loadsInFlight().length;
    const held = heldLoad<string>();
    const returned = lazyLoad(held.load);
    const seen = returned.catch((error: unknown) => error);

    held.fail(new Error("no module"));

    expect(await seen).toEqual(new Error("no module"));
    await Promise.all(loadsInFlight());
    expect(loadsInFlight()).toHaveLength(before);
  });
});
