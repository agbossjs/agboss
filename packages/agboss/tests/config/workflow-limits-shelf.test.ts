/**
 * #1318c: `workflows.<name>.executionLimits` and `workflows.<name>.historyTtl` of a profile, read through the one
 * carrier of the components' options (`ComponentOptions`) by every path that reads them: the run (steps, depth, the
 * tree's concurrency cap, the history a finished tree keeps), the assembly rules, the worst case and `describe`.
 * The parity tests hold that one value is the same on all of them — a limit enforced at run time that the
 * static analysis does not see (or the other way round) would let a flow past what it was written under.
 * A declared `@Workflow` is never changed.
 */
import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { beforeEach, describe, expect, it } from "vitest";
import { applicationOf, type AssembledApplication } from "../../src/application/assemble.js";
import { ProfileError, ProfileErrorReason } from "../../src/config/profile-error.js";
import { ComponentOptions } from "../../src/components/component-options.js";
import { describedLimitsOf } from "../../src/describe/limits.js";
import { describedTreeOf } from "../../src/describe/tree.js";
import { declaredExecutionLimitsOf } from "../../src/flow/decorators/workflow.js";
import { checkWorkflow } from "../../src/flow/analyse/analyse.js";
import { historyKeeperOf } from "../../src/app/app-deps-parts.js";
import { historySourcesOf } from "../../src/app/history-sources.js";
import {
  ExecutionHistoryRepository,
  StepsLimitExceededError,
  Workflow,
  type DepthLimitExceededError,
} from "../../src/index.js";
import { ChildExecutionStatus } from "../../src/flow/runtime/child-records.js";
import { TestConcurrency, testWith } from "../../src/testing/index.js";
import { days, Ttl, seconds } from "../../src/units/index.js";
import { execute, onStart } from "../helpers/flow.js";
import {
  CountdownWorkflowStart,
  CountStoppedWorkflowFinish,
  resetRecursionLog,
} from "../flow/runtime/fixtures/recursion.workflow.js";
import { BatchWorkflowStart } from "../flow/runtime/fixtures/tree-batch.workflow.js";
import { resetTreeLog, treeLog, untilLogged } from "../flow/runtime/fixtures/tree-task.workflow.js";
import {
  BatchWorkflow,
  CountdownWorkflow,
  LimitsApplication,
  LimitsKeptAction,
  LimitsKeptFinish,
  LimitsKeptStart,
  LimitsKeptWorkflow,
  LimitsSpinStart,
  LimitsSpinWorkflow,
} from "./fixtures/limits-app/limits.application.js";

const assembled = (profile?: string | readonly string[]) =>
  applicationOf(LimitsApplication, profile === undefined ? {} : { profile });

const failure = async (attempt: Promise<unknown>): Promise<unknown> => {
  try {
    await attempt;
  } catch (error) {
    return error;
  }
  throw new Error("expected the assembly to fail");
};

const profileFailure = async (profile: string): Promise<ProfileError> => {
  const error = await failure(assembled(profile));
  if (error instanceof ProfileError) return error;
  throw error;
};

/** The assembled workflow of a class. */
const bundleOf = (app: AssembledApplication, workflow: abstract new () => unknown) => {
  const found = app.workflows.find((one) => one.graph.type === workflow);
  if (found === undefined) throw new Error("the application has no such workflow");
  return found;
};

const spinTest = testWith(LimitsApplication);
const spinTight = testWith(LimitsApplication, { profile: "tight" });
const spinEvery = testWith(LimitsApplication, { profile: "every" });

beforeEach(() => {
  resetRecursionLog();
  resetTreeLog();
});

describe("maxSteps: one bound on every path (actions count, #1278b)", () => {
  /** What every path reads of the spin workflow's steps limit, all together. */
  const readings = (app: AssembledApplication) => {
    const bundle = bundleOf(app, LimitsSpinWorkflow);
    const worst = bundle.graph.analysis.worstCases[0];
    return {
      bundle: bundle.maxSteps,
      described: describedLimitsOf(bundle).maxSteps,
      isSet: describedLimitsOf(bundle).isMaxStepsSet,
      worstCase: worst?.steps,
      isCapped: worst?.isStepsCapped,
      carrier: app.componentOptions.executionLimitsOf(LimitsSpinWorkflow).maxSteps ?? 40,
    };
  };

  it("declared: 40 on the bundle, in describe, in the worst case and in the carrier", async () => {
    expect(readings(await assembled())).toEqual({
      bundle: 40,
      described: 40,
      isSet: true,
      worstCase: 40,
      isCapped: true,
      carrier: 40,
    });
  });

  it("a profile's 5 is the bundle's, describe's and the worst case's alike", async () => {
    expect(readings(await assembled("tight"))).toEqual({
      bundle: 5,
      described: 5,
      isSet: true,
      worstCase: 5,
      isCapped: true,
      carrier: 5,
    });
  });

  spinTest("declared: the run is stopped at the declared bound", async ({ app }) => {
    await expect(execute(app, LimitsSpinStart, { text: "go" })).rejects.toMatchObject({
      code: "limit.steps",
      maxSteps: 40,
      steps: 41,
    });
  });

  spinTight(
    "a profile's bound is the one the run is stopped at: 5 steps, the 6th fails",
    async ({ app }) => {
      const run = execute(app, LimitsSpinStart, { text: "go" });

      await expect(run).rejects.toBeInstanceOf(StepsLimitExceededError);
      await expect(run).rejects.toMatchObject({ maxSteps: 5, steps: 6 });
    },
  );

  spinEvery("the workflow's own overlay wins over the one for every workflow", async ({ app }) => {
    await expect(execute(app, LimitsSpinStart, { text: "go" })).rejects.toMatchObject({
      maxSteps: 7,
      steps: 8,
    });
  });

  it("the analysis refuses a bound the profile sets below what a run needs, as it does a declared one", async () => {
    const error = await failure(assembled("low"));

    expect(error).toBeInstanceOf(ConfigError.GraphRules);
    expect((error as ConfigError.GraphRules).violations.map((one) => one.code)).toContain(
      "limits.max-steps-too-low",
    );
  });

  it("the rules of the analysis read the profile's value: the same flow, the same codes as a declared one", async () => {
    const app = await assembled("tight");
    const limitsOf = app.componentOptions.executionLimitsOf;

    const underProfile = checkWorkflow(LimitsSpinWorkflow, { limits: limitsOf });
    const declared = checkWorkflow(LimitsSpinWorkflow);

    expect(underProfile.errors).toEqual([]);
    expect(underProfile.analysis?.worstCases[0]?.steps).toBe(5);
    expect(declared.analysis?.worstCases[0]?.steps).toBe(40);
    // 5 is below the longest way the loop can take, 40 as well: both warn, naming their own bound
    expect(underProfile.warnings.map((one) => one.code)).toContain(
      "limits.max-steps-below-worst-case",
    );
    expect(
      underProfile.warnings.find((one) => one.code === "limits.max-steps-below-worst-case")
        ?.message,
    ).toContain("maxSteps is 5");
  });

  it("layered profiles fold field by field, a later one winning: tight then wide", async () => {
    const app = await assembled(["tight", "wide"]);

    expect(app.componentOptions.executionLimitsOf(LimitsSpinWorkflow)).toEqual({ maxSteps: 8 });
    expect(app.componentOptions.executionLimitsOf(CountdownWorkflow)).toEqual({ maxDepth: 2 });
    expect(bundleOf(app, LimitsSpinWorkflow).maxSteps).toBe(8);
  });

  it("never changes the declared workflow, nor another assembly of it", async () => {
    await assembled("tight");
    const plain = await assembled();

    expect(declaredExecutionLimitsOf(LimitsSpinWorkflow)).toEqual({ maxSteps: 40 });
    expect(declaredExecutionLimitsOf(BatchWorkflow)).toEqual({ maxConcurrency: 2 });
    expect(bundleOf(plain, LimitsSpinWorkflow).maxSteps).toBe(40);
    expect(plain.componentOptions).toBe(ComponentOptions.none);
  });
});

describe("maxDepth: the recursion's level, on the run and in the analysis", () => {
  const depthTest = testWith(LimitsApplication);
  const depthTight = testWith(LimitsApplication, { profile: "tight" });

  it("the analysis, describe and the tree of describe read the profile's 2", async () => {
    const app = await assembled("tight");
    const bundle = bundleOf(app, CountdownWorkflow);
    const tree = describedTreeOf(app).workflows.find((one) => one.name === "countdown-workflow");

    expect(bundle.graph.analysis.recursion?.maxDepth).toBe(2);
    expect(describedLimitsOf(bundle).maxDepth).toBe(2);
    expect(tree?.children[0]?.maxDepth).toBe(2);
    expect(bundleOf(await assembled(), CountdownWorkflow).graph.analysis.recursion?.maxDepth).toBe(
      3,
    );
  });

  depthTest("declared: the third level launches the fourth, which is refused", async ({ app }) => {
    const result = await execute(app, CountdownWorkflowStart, { left: 5 });

    expect(result).toFinishWith(CountStoppedWorkflowFinish, { depth: 3 });
  });

  depthTight(
    "a profile's 2: the second level launching the third is refused at the run",
    async ({ app }) => {
      const result = await execute(app, CountdownWorkflowStart, { left: 5 });

      expect(result).toFinishWith(CountStoppedWorkflowFinish, { depth: 2 });
      const refused = result.children[0]?.children[0];
      expect(refused).toMatchObject({
        depth: 3,
        status: ChildExecutionStatus.Failed,
        error: { code: "limit.depth" },
      });
      expect(refused?.error?.message).toBe(
        "countdown-workflow went 3 levels deep; its maxDepth is 2",
      );
      const error = refused?.error as Partial<DepthLimitExceededError> | undefined;
      expect(error?.name).toBe("DepthLimitExceededError");
    },
  );
});

describe("maxConcurrency: the tree's cap, on the run, in describe and in the analysis", () => {
  const REAL = { concurrency: TestConcurrency.Real };
  const capDeclared = testWith(LimitsApplication, REAL);
  const capWide = testWith(LimitsApplication, { ...REAL, profile: "tight" });
  const task = (name: string) => ({ name, seconds: 1, outcome: "ok" as const });
  const tasks = [task("a"), task("b"), task("c"), task("d")];

  it("describe reads the cap the profile leaves, and whether it is set", async () => {
    const wide = describedLimitsOf(bundleOf(await assembled("tight"), BatchWorkflow));
    const declared = describedLimitsOf(bundleOf(await assembled(), BatchWorkflow));

    expect([wide.maxConcurrency, wide.isMaxConcurrencySet]).toEqual([4, true]);
    expect([declared.maxConcurrency, declared.isMaxConcurrencySet]).toEqual([2, true]);
  });

  capDeclared("declared: a cap of 2, two at work and two waiting", async ({ app, clock }) => {
    const execution = execute(app, BatchWorkflowStart, tasks);
    await untilLogged("start b");
    const atFirst = [...treeLog.events];
    await clock.advance(seconds(1));
    await untilLogged("start d");
    await clock.advance(seconds(1));
    await execution;

    expect(atFirst).toEqual(["start a", "start b"]);
    expect(treeLog.mostWorking).toBe(2);
  });

  capWide("a profile's cap of 4: all four at work at once", async ({ app, clock }) => {
    const execution = execute(app, BatchWorkflowStart, tasks);
    await untilLogged("start d");
    const atFirst = [...treeLog.events];
    await clock.advance(seconds(1));
    await execution;

    expect(atFirst).toEqual(["start a", "start b", "start c", "start d"]);
    expect(treeLog.mostWorking).toBe(4);
  });

  it("the rule for a child above its parent reads the profile's value", async () => {
    const app = await assembled("tight");
    const own = checkWorkflow(BatchWorkflow, { limits: app.componentOptions.executionLimitsOf });

    expect(own.errors).toEqual([]);
    expect(app.componentOptions.executionLimitsOf(BatchWorkflow).maxConcurrency).toBe(4);
  });
});

describe("historyTtl: the history a finished tree keeps", () => {
  const keptDeclared = testWith(LimitsApplication);
  const keptNone = testWith(LimitsApplication, { profile: "tight" });

  it("the carrier answers with the profile's value over the declared one, per workflow", async () => {
    expect((await assembled()).componentOptions.historyTtlOf(LimitsKeptWorkflow)).toBe(days(90));
    expect((await assembled("tight")).componentOptions.historyTtlOf(LimitsKeptWorkflow)).toBe(
      Ttl.None,
    );
    expect(
      (await assembled(["tight", "wide"])).componentOptions.historyTtlOf(LimitsKeptWorkflow),
    ).toBe(Ttl.Forever);
    // a workflow the profile leaves alone keeps what it declares
    expect((await assembled("tight")).componentOptions.historyTtlOf(LimitsSpinWorkflow)).toBe(
      Ttl.Forever,
    );
  });

  keptDeclared("declared: the finished tree's record is kept", async ({ app }) => {
    await execute(app, LimitsKeptStart, { text: "note" });

    const record = await app
      .resolve(ExecutionHistoryRepository)
      .findByTenantIdAndExecutionId("default", "execution-1");

    expect(record?.status).toBeDefined();
  });

  keptNone("a profile's Ttl.None: nothing of the tree is kept", async ({ app }) => {
    await execute(app, LimitsKeptStart, { text: "note" });

    const record = await app
      .resolve(ExecutionHistoryRepository)
      .findByTenantIdAndExecutionId("default", "execution-1");

    expect(record).toBeUndefined();
  });

  it("the keeper is made for the workflow that keeps its history, not for one that keeps none", async () => {
    const sources = { executionHistory: {} as never, infrastructure: {} };
    const parts = {
      clock: {},
      contexts: { application: {} },
      pii: { observability: {} },
      answers: {},
    } as never;

    const keeps = async (profile?: string | readonly string[]) =>
      historyKeeperOf(
        historySourcesOf(sources, bundleOf(await assembled(profile), LimitsKeptWorkflow)),
        parts,
      );

    expect((await keeps()).executionHistory).toBeDefined();
    expect((await keeps(["tight", "wide"])).executionHistory).toBeDefined();
    expect(await keeps("tight")).toEqual({});
  });
});

describe("every workflow, and what a profile gets wrong", () => {
  it('"*" reaches every workflow, a workflow overlay wins over it where both set a limit', async () => {
    const app = await assembled("every");
    const limitsOf = app.componentOptions.executionLimitsOf;

    expect(limitsOf(LimitsSpinWorkflow)).toEqual({ maxSteps: 7, maxPathDepth: 6 });
    expect(limitsOf(CountdownWorkflow)).toEqual({ maxDepth: 3, maxPathDepth: 6 });
    expect(limitsOf(BatchWorkflow)).toEqual({ maxConcurrency: 2, maxPathDepth: 6 });
  });

  it("a workflow the application lacks is a typo", async () => {
    expect((await profileFailure("ghost")).reason).toBe(ProfileErrorReason.Unknown);
  });

  it.each(["bad-steps", "bad-depth", "bad-ttl", "bad-concurrency", "unknown-limit"])(
    "%s: a limit that is no whole number from its minimum, or no limit at all, is refused with its path",
    async (profile) => {
      const error = await profileFailure(profile);

      expect(error.reason).toBe(ProfileErrorReason.Invalid);
      expect(error.message).toContain("workflows");
    },
  );
});
