import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunnerTask } from "vitest";
import { lazyLoad } from "../../infrastructure/clock.js";

/**
 * `runConformanceSabotage` (#831): a store package proves the contract suites bite on its database
 * — a deliberately broken store (a check-then-write acquire, leases on the caller's clock) run
 * through `storeConformance` in a fixture file must fail the rules it breaks. A failing suite cannot
 * be asserted in the run it fails, so the fixture runs in a vitest of its own (`startVitest`), and
 * every case comes back with its describe path, its state, its errors and a skip's reason, for the
 * calling test to assert on. What would let a sabotage pass unnoticed fails here instead: a fixture
 * that does not load, or that registers no case.
 */

/** One case of a sabotage fixture's run. */
export interface SabotageCase {
  /** The fixture file, relative to `root`. */
  readonly file: string;
  /** The describe blocks around it, outermost first: `["lease contract (mine)", …]`. */
  readonly suites: readonly string[];
  readonly name: string;
  readonly state: "pass" | "fail" | "skip" | "todo" | "run" | "queued" | "only" | undefined;
  /** The messages of its errors. */
  readonly errors: readonly string[];
  /** Why it was skipped, when it skipped itself with a reason. */
  readonly note?: string | undefined;
}

/** What a sabotage fixture's run reported. */
export interface SabotageRun {
  readonly cases: readonly SabotageCase[];
  /** Whether the run failed: a case failed (what a sabotage is for). */
  readonly isFailed: boolean;
  /** The cases of the outermost describe `suite` (`"lease contract (mine)"`) that failed. */
  failedIn(suite: string): readonly SabotageCase[];
}

/** How a sabotage fixture runs. */
export interface ConformanceSabotageOptions {
  /** The project's root (a path or a file URL): the fixture is resolved from it, `node_modules` too. */
  readonly root: string | URL;
  /** The fixture files, relative to `root`: `tests/contracts/fixtures/sabotage.conformance-fixture.ts`. */
  readonly fixtures: readonly string[];
  /** Each case's bound, ms (vitest's `testTimeout`); default 120 000. */
  readonly testTimeout?: number;
  /** Each hook's bound, ms; default 60 000. */
  readonly hookTimeout?: number;
  /** How many workers the nested run may use; default 1. */
  readonly maxWorkers?: number;
}

/** The reason a case skipped itself with (`context.skip(note)`), which the result carries untyped. */
const noteOf = (task: RunnerTask): string | undefined => {
  const note: unknown = task.result === undefined ? undefined : Reflect.get(task.result, "note");
  return typeof note === "string" ? note : undefined;
};

function casesOf(task: RunnerTask, file: string, suites: readonly string[]): SabotageCase[] {
  if (task.type === "suite")
    return task.tasks.flatMap((child) => casesOf(child, file, [...suites, task.name]));
  return [
    {
      file,
      suites,
      name: task.name,
      state: task.result?.state,
      errors: (task.result?.errors ?? []).map((error) => error.message),
      note: noteOf(task),
    },
  ];
}

/** A file of the run that did not load (a syntax error, a throw while registering). */
interface LoadFailure {
  readonly name: string;
  readonly message: string;
}

/**
 * Runs `options.fixtures` in a vitest of their own, quietly, and returns every case. Rejects —
 * never a run to assert on — when a fixture does not load (`StoreConformanceError` of a set it
 * refuses included: assert that with `storeConformance` itself) or the run has no case at all.
 */
export async function runConformanceSabotage(
  options: ConformanceSabotageOptions,
): Promise<SabotageRun> {
  if (options.fixtures.length === 0)
    throw new RangeError("runConformanceSabotage: no fixture to run");
  const root = typeof options.root === "string" ? options.root : fileURLToPath(options.root);
  const { startVitest } = await lazyLoad(import("vitest/node"));
  const exitCode = process.exitCode;
  const maxWorkers = options.maxWorkers ?? 1;
  const vitest = await startVitest("test", [], {
    root,
    config: false,
    watch: false,
    include: [...options.fixtures],
    globalSetup: [],
    reporters: [{}],
    coverage: { enabled: false },
    testTimeout: options.testTimeout ?? 120_000,
    hookTimeout: options.hookTimeout ?? 60_000,
    maxWorkers,
    minWorkers: Math.min(1, maxWorkers),
  });
  try {
    const files = vitest.state.getFiles();
    const failedToLoad: LoadFailure[] = files.flatMap((file) =>
      file.tasks.length === 0 && file.result?.state === "fail"
        ? [
            {
              name: relative(root, file.filepath),
              message: (file.result.errors ?? []).map((error) => error.message).join("; "),
            },
          ]
        : [],
    );
    if (failedToLoad.length > 0)
      throw new Error(
        `runConformanceSabotage: ${failedToLoad.map((one) => `${one.name} did not load: ${one.message}`).join("\n")}`,
      );
    const cases = files.flatMap((file) =>
      file.tasks.flatMap((task) => casesOf(task, relative(root, file.filepath), [])),
    );
    if (cases.length === 0)
      throw new Error(
        `runConformanceSabotage: ${options.fixtures.join(", ")} registered no case — check the fixtures' paths`,
      );
    const isFailed = files.some((file) => file.result?.state === "fail");
    return {
      cases,
      isFailed,
      failedIn: (suite) =>
        cases.filter((found) => found.suites[0] === suite && found.state === "fail"),
    };
  } finally {
    await vitest.close();
    process.exitCode = exitCode;
  }
}
