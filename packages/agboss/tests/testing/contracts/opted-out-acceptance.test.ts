/**
 * #543 acceptance — the corners of the opt-out the decision's tests leave open:
 * - the opt-out read from the class chain: a store opted out only through its parent is refused,
 *   named by its own class; a subclass restating `LeaseCheck.Atomic` runs every fencing case;
 * - the flag beside `without`: the fenced-effect contract left out, the outbound-call store's
 *   fencing cases skipped and shown; both fencing contracts left out, the flag refused;
 * - a fencing contract run alone with the flag shows the missing protection as a passing case (#566);
 * - a reporter that hides skipped cases still prints the opt-out.
 */
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { startVitest } from "vitest/node";
import {
  OPT_OUT_SHOWN_CASE,
  OPTED_OUT_REASON,
} from "../../../src/testing/contracts/fencing-gate.js";
import { runContractFixtures, type FixtureCase, type FixtureRun } from "./fixture-runs.js";

const INHERITED = "opted-out-inherited.contract-fixture.ts";
const RESTATED = "opted-out-restated.contract-fixture.ts";
const WITHOUT = "opted-out-without.contract-fixture.ts";
const NO_FENCING = "opted-out-no-fencing.contract-fixture.ts";
const ALONE = "opted-out-alone.contract-fixture.ts";
const ALONE_ATOMIC = "opted-out-alone-atomic.contract-fixture.ts";
const ACCEPTED = "fencing-opted-out.contract-fixture.ts";

const OUTBOUND = "outbound call contract";
const SHOWN = "gives NO double-charge protection for outbound calls";
const FLAG_CASE =
  "accepts an opt-out only where a store declares one (acceptWithoutDoubleChargeProtection)";

let run: FixtureRun;

beforeAll(async () => {
  run = await runContractFixtures([INHERITED, RESTATED, WITHOUT, NO_FENCING, ALONE, ALONE_ATOMIC]);
}, 180_000);

const casesOf = (file: string, suite: string): readonly FixtureCase[] =>
  run.cases.filter((found) => found.file === file && found.suites[0] === suite);

const named = (cases: readonly FixtureCase[], state: FixtureCase["state"]): string[] =>
  cases.filter((found) => found.state === state).map((found) => found.name);

describe("#543 acceptance: the opt-out read from the class chain", () => {
  it("a store opted out only through its parent fails every fencing case, named by its own class", () => {
    const outbound = casesOf(INHERITED, `${OUTBOUND} (an opt-out inherited, not accepted)`);
    const failed = outbound.filter((found) => found.state === "fail");

    expect(failed.length).toBeGreaterThan(10);
    for (const found of failed)
      expect(found.errors.join("\n")).toContain(
        "[store-conformance.opted-out-store] InheritedOptOutCalls declares LeaseCheck.WithoutDoubleChargeProtection",
      );
    expect(named(outbound, "pass").length).toBeGreaterThan(20);
    expect(
      named(casesOf(INHERITED, "store set (an opt-out inherited, not accepted)"), "fail"),
    ).toEqual([
      "the outbound-call store is on the backend of the lease store it checks, or opts out",
    ]);
  });

  it("a subclass restating LeaseCheck.Atomic runs and passes every fencing case; the flag nobody needs fails", () => {
    const outbound = casesOf(RESTATED, `${OUTBOUND} (an atomic check restated, the flag set)`);
    const set = casesOf(RESTATED, "store set (an atomic check restated, the flag set)");

    expect(outbound.filter((found) => found.state !== "pass")).toEqual([]);
    expect(outbound.length).toBeGreaterThan(30);
    expect(named(set, "fail")).toEqual([FLAG_CASE]);
    expect(named(set, "skip")).toEqual([SHOWN]);
  });
});

describe("#543 acceptance: the flag beside without", () => {
  it("fenced effects left out: the outbound fencing cases skipped with the reason, the opt-out shown, nothing failed, no fenced-effect line", () => {
    const outbound = casesOf(WITHOUT, `${OUTBOUND} (an opt-out accepted, fenced effects left out)`);
    const set = casesOf(WITHOUT, "store set (an opt-out accepted, fenced effects left out)");
    const skipped = outbound.filter((found) => found.state === "skip");

    expect(run.cases.filter((found) => found.file === WITHOUT && found.state === "fail")).toEqual(
      [],
    );
    expect(skipped.length).toBeGreaterThan(10);
    expect(skipped.every((found) => found.note === OPTED_OUT_REASON)).toBe(true);
    expect(named(set, "pass")).toEqual(expect.arrayContaining([SHOWN, FLAG_CASE]));
    expect(set.map((found) => found.name)).not.toContain(
      "gives NO double-charge protection for fenced effects",
    );
  });

  it("both fencing contracts left out: no store can declare the opt-out, so the flag fails", () => {
    const set = casesOf(NO_FENCING, "store set (the flag with no fencing store)");

    expect(named(set, "fail")).toEqual([FLAG_CASE]);
    expect(set.map((found) => found.name).filter((name) => name.startsWith("gives NO"))).toEqual(
      [],
    );
  });
});

describe("#543 acceptance: a fencing contract run alone with the flag", () => {
  it("skips its fencing cases and shows the missing protection as a passing case of its own suite", () => {
    const outbound = casesOf(ALONE, `${OUTBOUND} (an opted-out store run alone)`);

    expect(named(outbound, "fail")).toEqual([]);
    expect(named(outbound, "skip").length).toBeGreaterThan(10);
    expect(named(outbound, "pass")).toContain(OPT_OUT_SHOWN_CASE);
  });

  it("on a store that does not opt out, the shown case fails — drop the flag — and every fencing case runs and passes", () => {
    const outbound = casesOf(ALONE_ATOMIC, `${OUTBOUND} (an atomic store run alone, the flag set)`);
    const shown = outbound.find((found) => found.name === OPT_OUT_SHOWN_CASE);

    expect(named(outbound, "fail")).toEqual([OPT_OUT_SHOWN_CASE]);
    expect(shown?.errors.join("\n")).toContain(
      "[store-conformance.opt-out-not-declared] acceptWithoutDoubleChargeProtection is set, but InMemoryOutboundCallRepository does not declare",
    );
    expect(named(outbound, "skip")).toEqual([]);
  });
});

const PACKAGE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** What the verbose reporter prints for `fixture` with skipped cases hidden. */
async function printedWithSkipsHidden(fixture: string): Promise<string> {
  let printed = "";
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done): void {
      printed += chunk.toString();
      done();
    },
  });
  const exitCode = process.exitCode;
  const vitest = await startVitest(
    "test",
    [],
    {
      root: PACKAGE_ROOT,
      config: false,
      watch: false,
      include: [`tests/fixtures/contracts/${fixture}`],
      reporters: ["verbose"],
      hideSkippedTests: true,
      coverage: { enabled: false },
      testTimeout: 2000,
    },
    {},
    { stdout: sink, stderr: sink },
  );
  await vitest.close();
  process.exitCode = exitCode;
  return printed;
}

describe("#543 acceptance: a reporter that hides skipped cases", () => {
  it("still prints the opt-out, and none of the skipped fencing cases", async () => {
    const printed = await printedWithSkipsHidden(ACCEPTED);

    expect(printed).toContain(SHOWN);
    expect(printed).not.toContain("races across leases");
    expect(printed).not.toContain(OPTED_OUT_REASON);
  }, 120_000);
});
