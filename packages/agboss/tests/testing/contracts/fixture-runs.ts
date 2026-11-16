/**
 * Runs `*.contract-fixture.ts` files in a vitest of their own (#481, `startVitest` from
 * `vitest/node`): the only way to see a published suite fail without failing this run. Each case
 * comes back with its file, its describe path, its name and its state.
 */
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunnerTask } from "vitest";
import { startVitest } from "vitest/node";

const PACKAGE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** One case of a fixture run. */
export interface FixtureCase {
  /** The fixture file, relative to tests/fixtures/contracts. */
  readonly file: string;
  /** The describe blocks around it, outermost first: `["lease contract (mine)", …]`. */
  readonly suites: readonly string[];
  readonly name: string;
  readonly state: "pass" | "fail" | "skip" | "todo" | "run" | "queued" | "only" | undefined;
  /** The messages of its errors. */
  readonly errors: readonly string[];
  /** Why it was skipped, when a case skipped itself with a note (#543). */
  readonly note?: string | undefined;
}

/** What a fixture run reported. */
export interface FixtureRun {
  readonly cases: readonly FixtureCase[];
  /** Whether the run failed (a failing case, a file that did not load). */
  readonly isFailed: boolean;
}

/** The note a case skipped itself with (`context.skip(note)`), which the result carries untyped. */
const noteOf = (task: RunnerTask): string | undefined => {
  const note: unknown = task.result === undefined ? undefined : Reflect.get(task.result, "note");
  return typeof note === "string" ? note : undefined;
};

function casesOf(task: RunnerTask, file: string, suites: readonly string[]): FixtureCase[] {
  if (task.type === "suite") {
    return task.tasks.flatMap((child) => casesOf(child, file, [...suites, task.name]));
  }
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

/**
 * How long a case of a fixture may take before it fails as hung. A broken store may leave a case
 * waiting: fail it soon, not at the default 5 s.
 */
const FIXTURE_CASE_TIMEOUT = 2000;

/**
 * The bound for fixtures whose cases do real work: the lease contract's clock-skew cases wait one
 * real second, and under a loaded machine (3 workers and 2 busy loops, #1190) the 2 s above left
 * them a second of room. Sized to those waits with ten times their length.
 */
export const LOADED_CASE_TIMEOUT = 10_000;

/** Runs `fixtures` (names in tests/fixtures/contracts) in a nested vitest, quietly. */
export async function runContractFixtures(
  fixtures: readonly string[],
  testTimeout: number = FIXTURE_CASE_TIMEOUT,
): Promise<FixtureRun> {
  const exitCode = process.exitCode;
  const vitest = await startVitest("test", [], {
    root: PACKAGE_ROOT,
    config: false,
    watch: false,
    include: fixtures.map((fixture) => `tests/fixtures/contracts/${fixture}`),
    reporters: [{}],
    coverage: { enabled: false },
    testTimeout,
  });
  try {
    const files = vitest.state.getFiles();
    const cases = files.flatMap((file) =>
      file.tasks.flatMap((task) =>
        casesOf(task, relative("tests/fixtures/contracts", file.name), []),
      ),
    );
    const isFailed = files.some((file) => file.result?.state === "fail");
    return { cases, isFailed };
  } finally {
    await vitest.close();
    process.exitCode = exitCode;
  }
}

/** The names of the cases of `run` in `file` whose state is `state`. */
export const namesOf = (
  run: FixtureRun,
  file: string,
  state: FixtureCase["state"],
): readonly string[] =>
  run.cases
    .filter((found) => found.file === file && found.state === state)
    .map((found) => found.name);
