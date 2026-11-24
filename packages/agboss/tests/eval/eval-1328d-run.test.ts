/**
 * #1328d: `beforeAttempt` / `afterAttempt` around each run of a case, the public `runEvalSuite` and
 * `compareEvalSuite` over a built application, and a judge's pinned provider.
 */
import { afterEach, describe, expect, it } from "vitest";
import { CheckStatus, EvalSuite, evalCase, turn } from "../../src/eval/index.js";
import { compareEvalSuiteWith } from "../../src/eval/run/compare-suite.js";
import { runEvalSuiteWith } from "../../src/eval/run/public-run.js";
import { runSuiteOn } from "../../src/eval/run/run-suite.js";
import { TestEnvironment } from "../../src/testing/environment.js";
import { replyWith } from "../../src/testing/index.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import type { BuiltApplication } from "../../src/application/create-app.js";
import {
  DeskAgent,
  DeskAnswerDto,
  DeskWorkflowStart,
  EvalDeskApplication,
} from "../flow/fixtures/eval-desk.fixture.js";

const TENANT = { tenantId: "eval-acme", plan: "pro" } as const;
const answer = replyWith(DeskAnswerDto, { text: "Order 9 shipped." });

const seen: string[] = [];

@EvalSuite({
  name: "attempts-eval-suite",
  description: "Hooks around every run",
  start: DeskWorkflowStart,
  beforeAttempt: ({ case: name, run }) => {
    seen.push(`suite before ${name} #${String(run)}`);
  },
  afterAttempt: ({ case: name, run }) => {
    seen.push(`suite after ${name} #${String(run)}`);
  },
  cases: [
    evalCase({
      name: "hooked",
      tenant: TENANT,
      execution: { userId: "eval-user-1" },
      input: { text: "Where is order 9?" },
      beforeAttempt: async () => {
        await Promise.resolve();
        seen.push("case before");
      },
      afterAttempt: () => {
        seen.push("case after");
      },
    }),
  ],
})
class AttemptsEvalSuite {}

@EvalSuite({
  name: "broken-hooks-eval-suite",
  description: "Hooks that throw",
  start: DeskWorkflowStart,
  cases: [
    evalCase({
      name: "cannot-start",
      tenant: TENANT,
      execution: { userId: "eval-user-1" },
      input: { text: "Where is order 9?" },
      beforeAttempt: () => {
        throw new Error("the database is not reset");
      },
      afterAttempt: () => {
        seen.push("cleaned up after a run that did not start");
      },
    }),
    evalCase({
      name: "cannot-clean",
      tenant: TENANT,
      execution: { userId: "eval-user-2" },
      input: { text: "Where is order 9?" },
      afterAttempt: () => {
        throw new Error("the database is not cleaned");
      },
    }),
  ],
})
class BrokenHooksEvalSuite {}

let environment: TestEnvironment | undefined;

afterEach(async () => {
  await environment?.close();
  environment = undefined;
  seen.length = 0;
});

async function evalApp(): Promise<{ env: TestEnvironment; built: BuiltApplication }> {
  const env = await TestEnvironment.of(EvalDeskApplication);
  environment = env;
  return { env, built: await env.newApp() };
}

describe("#1328d: beforeAttempt / afterAttempt", () => {
  it("run around each repetition: the suite's before, the case's before, the run, the case's after, the suite's after", async () => {
    const { env, built } = await evalApp();
    env.mockLlm(DeskAgent).thenReturn(answer, answer);

    const report = await runSuiteOn(built, AttemptsEvalSuite, { runs: 2 });

    expect(seen).toEqual([
      "suite before hooked #1",
      "case before",
      "case after",
      "suite after hooked #1",
      "suite before hooked #2",
      "case before",
      "case after",
      "suite after hooked #2",
    ]);
    expect(report.cases[0]?.passed).toBe(2);
  });

  it("a before that throws fails the run without starting it, its after still runs; an after that throws fails a run that passed", async () => {
    const { env, built } = await evalApp();
    env.mockLlm(DeskAgent).thenReturn(answer);

    const report = await runSuiteOn(built, BrokenHooksEvalSuite, { runs: 1 });
    const [notStarted] = report.cases[0]?.runResults ?? [];
    const [notCleaned] = report.cases[1]?.runResults ?? [];

    expect(notStarted).toMatchObject({
      passed: false,
      checks: [],
      error: {
        code: "eval.attempt-hook-failed",
        message: "beforeAttempt threw Error",
      },
    });
    expect(seen).toEqual(["cleaned up after a run that did not start"]);
    expect(notCleaned?.passed).toBe(false);
    expect(notCleaned?.error).toEqual({
      code: "eval.attempt-hook-failed",
      message: "afterAttempt threw Error",
    });
    expect(notCleaned?.checks.every((check) => check.status === CheckStatus.Passed)).toBe(true);
  });
});

@EvalSuite({
  name: "public-eval-suite",
  description: "Run through the public entry points",
  start: DeskWorkflowStart,
  cases: [
    evalCase({
      name: "one",
      tenant: TENANT,
      execution: { userId: "eval-user-1" },
      turns: [turn({ text: "Where is order 9?" })],
    }),
  ],
})
class PublicEvalSuite {}

describe("#1328d: runEvalSuite and compareEvalSuite", () => {
  it("runEvalSuite builds the application, runs every case `runs` times and closes it", async () => {
    const env = await TestEnvironment.of(EvalDeskApplication);
    environment = env;
    env.mockLlm(DeskAgent).thenReturn(answer, answer);
    const gateway = createScriptedGateway(env.book, env.clock);

    const report = await runEvalSuiteWith(EvalDeskApplication, PublicEvalSuite, {
      runs: 2,
      seams: { gateway },
    });

    expect(report.suite).toBe("public-eval-suite");
    expect(report.runs).toBe(2);
    expect(report.cases[0]?.passed).toBe(2);
  });

  it("compareEvalSuite runs the suite once per variant and reads each later one against the first", async () => {
    const env = await TestEnvironment.of(EvalDeskApplication);
    environment = env;
    env.mockLlm(DeskAgent).thenReturn(answer, answer);
    const gateway = createScriptedGateway(env.book, env.clock);

    const comparison = await compareEvalSuiteWith(EvalDeskApplication, PublicEvalSuite, {
      variants: [{ name: "base" }, { name: "candidate" }],
      seams: { gateway },
    });

    expect(comparison.suite).toBe("public-eval-suite");
    expect(comparison.variants.map((variant) => variant.name)).toEqual(["base", "candidate"]);
    expect(comparison.comparisons.map((found) => [found.file, found.regressed])).toEqual([
      ["candidate", []],
    ]);
    expect(comparison.totalUsd).toBe(
      comparison.variants.reduce((sum, variant) => sum + variant.report.spend.totalUsd, 0),
    );
    expect(comparison.variants[1]?.latencyP50).toBeGreaterThanOrEqual(0);
  });

  it("a comparison needs two variants with names of their own", async () => {
    await expect(
      compareEvalSuiteWith(EvalDeskApplication, PublicEvalSuite, { variants: [{ name: "a" }] }),
    ).rejects.toThrow(/at least two variants/u);
    await expect(
      compareEvalSuiteWith(EvalDeskApplication, PublicEvalSuite, {
        variants: [{ name: "a" }, { name: "a" }],
      }),
    ).rejects.toThrow(/two variants are named "a"/u);
  });
});
