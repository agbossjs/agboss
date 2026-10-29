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
}

/** What a fixture run reported. */
export interface FixtureRun {
  readonly cases: readonly FixtureCase[];
  /** Whether the run failed (a failing case, a file that did not load). */
  readonly isFailed: boolean;
}

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
    },
  ];
}

/** Runs `fixtures` (names in tests/fixtures/contracts) in a nested vitest, quietly. */
export async function runContractFixtures(fixtures: readonly string[]): Promise<FixtureRun> {
  const exitCode = process.exitCode;
  const vitest = await startVitest("test", [], {
    root: PACKAGE_ROOT,
    config: false,
    watch: false,
    include: fixtures.map((fixture) => `tests/fixtures/contracts/${fixture}`),
    reporters: [{}],
    coverage: { enabled: false },
    // a broken store may leave a case waiting: fail it soon, not at the default 5 s
    testTimeout: 2000,
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
