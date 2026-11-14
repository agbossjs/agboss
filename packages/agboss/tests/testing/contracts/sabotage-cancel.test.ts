/**
 * #909 AC2: the cancel's contract cases and the explorer bite. Fencing stores whose cancel fence is
 * broken (tests/fixtures/contracts/cancel-broken-stores.ts, run by
 * cancel-sabotage.contract-fixture.ts in a vitest of its own) fail the cases of the guarantee: a
 * store with no cancel check fails the refusal cases and the explorer's `no-effect-after-cancel`
 * and its forced races; a store that reads the request before its transaction fails the case of a
 * cancel asked while the write is open. The core's own stores pass the same cases
 * (tests/infrastructure/store-conformance.{in-memory,sqlite}.test.ts).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { runContractFixtures, type FixtureRun } from "./fixture-runs.js";

const FIXTURE = "cancel-sabotage.contract-fixture.ts";

let run: FixtureRun;

beforeAll(async () => {
  run = await runContractFixtures([FIXTURE]);
}, 600_000);

/** The failed cases of the suite whose title starts with `prefix` and names `target`. */
const failedOf = (prefix: string, target: string): readonly string[] =>
  run.cases
    .filter(
      (found) =>
        found.state === "fail" &&
        (found.suites[0]?.startsWith(prefix) ?? false) &&
        (found.suites[0]?.includes(`(${target})`) ?? false),
    )
    .map((found) => found.name);

describe("#909 AC2: a store whose cancel fence is broken fails the cases", () => {
  it("no cancel check: a write and a send after the cancel land — the refusal cases fail", () => {
    expect(failedOf("fenced effect contract", "stores with no cancel check")).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^#909 AC1: a write after its tree's durable cancel is refused/),
        expect.stringMatching(/^#909 AC1: a child's key/),
        expect.stringMatching(/^#909 AC1: a cancel before the tree's first acquire/),
      ]),
    );
    expect(failedOf("outbound call contract", "stores with no cancel check")).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^#909 AC1: saveIfAbsent after its tree's durable cancel/),
        expect.stringMatching(/^#909 AC1: markPending after the cancel is refused/),
      ]),
    );
  });

  it("no cancel check: the explorer finds a write after the cancel and the forced races fail", () => {
    const failures = run.cases.filter(
      (found) =>
        found.state === "fail" && found.suites[0] === "interleavings (stores with no cancel check)",
    );
    expect(failures.flatMap((found) => found.errors).join("\n")).toMatch(
      /\[no-effect-after-cancel\]/u,
    );
    expect(failures.map((found) => found.name)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/a write against its tree's cancel \(#909\)/),
        expect.stringMatching(/a new intent against its tree's cancel \(#909\)/),
      ]),
    );
  });

  it("a cancel read before the transaction: the write that was open when the cancel answered lands after it", () => {
    expect(
      failedOf("fenced effect contract", "effects reading the cancel before the transaction"),
    ).toContainEqual(
      expect.stringMatching(/^#909 AC2: a cancel asked while the write's transaction is open/),
    );
  });

  it("a retention that lifts the mark by age alone: the tree not over has its write and its intent land after the cancel", () => {
    const target = "a retention that lifts the cancel's mark by age alone";

    expect(failedOf("fenced effect contract", target)).toContainEqual(
      expect.stringMatching(/^#909: a cancel's mark is not lifted by the retention/),
    );
    expect(failedOf("outbound call contract", target)).toContainEqual(
      expect.stringMatching(/^#909: a cancel's mark is not lifted by the retention/),
    );
  });
});
