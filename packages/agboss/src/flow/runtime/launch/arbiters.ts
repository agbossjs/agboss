import { ComponentKind } from "../records.js";
import { StepError } from "../../../core/error-families/step-errors.js";
import type { ModelReadingMask } from "../../../pii/model-boundary.js";
import type { Class } from "../../../components/injection.js";
import { normalisePromptText } from "../../../components/prompt-render.js";
import type { UsageRecord } from "../../../finops/usage.js";
import { WorkflowFinishTextDto } from "../../../dto/standard/framework.js";
import type { ArbiterClass } from "../../ast.js";
import {
  answerMethodsOf,
  arbiterOf,
  hasArbiterModel,
  isCodeArbiter,
  type ModelArbiterOptions,
} from "../../decorators/arbiter.js";
import { declarationOf } from "../../decorators/declaration.js";
import { Metadata } from "../../metadata.js";
import { passesThrough } from "../errors.js";
import type { ArbiterModels } from "./arbiter-call.js";
import { runArbiterCall } from "./arbiter-live.js";
import { observedJudging } from "./arbiter-events.js";

/**
 * The arbiter of a branch (#279 AC12, #1282): run inside the branch, under its slot and in its
 * frame, on the answer its target gave — one `.arbitratedBy(A)` per launch. A code arbiter's
 * `@Arbitrate(…targets)` method gets the answer (tracked as given by that target); with
 * `ArbiterModel` injected it may ask its own model; a declarative arbiter asks its model with the
 * target's criterion. An arbiter that throws, returns something other than a boolean or whose model
 * does not answer fails the branch with `StepError.Arbiter` — never a rejection — carrying what its model
 * calls spent. A limit or a cancel passes through as it is, its spend handed to `keepSpend`. Once
 * the launch is decided (its signal aborted) the check stops: a running code check is abandoned at
 * once; a model check's call, which cannot be stopped, is awaited for its cost — either way the
 * answer does not count (the caller sees the aborted signal).
 */

/** What the arbiter runs on: its instance and model, and the limits before a model call. */
export interface ArbiterDeps {
  /** A code arbiter's instance, from the application's container. */
  readonly instanceOf: (arbiter: Class) => unknown;
  /** A model arbiter's model (declarative, or the one its code injects). */
  readonly modelOf?: (arbiter: ArbiterClass) => ArbiterModels | undefined;
  /** Checks the execution's budgets before a model call, with what the check spent so far. */
  readonly beforeModelCall: (spent: readonly UsageRecord[]) => Promise<void>;
  /** The launch's signal: aborted once the quorum is decided. */
  readonly signal: AbortSignal;
  /** How a model arbiter's model reads the answer (#708): the answering target's PII policies. */
  readonly reading?: ModelReadingMask | undefined;
  /** Takes what a check spent when a limit or a cancel ends it, which no verdict carries. */
  readonly keepSpend?: (usage: readonly UsageRecord[]) => void;
}

/** The answer judged: the branch's node and its value. */
export interface JudgedAnswer {
  readonly node: string;
  readonly answer: unknown;
}

/** What the arbiter decided, what it cost, and who rejected. */
export interface ChainVerdict {
  readonly isAccepted: boolean;
  readonly rejectedBy: readonly string[];
  readonly usage: readonly UsageRecord[];
}

const nameOfTarget = (target: Class): string => declarationOf(target)?.options.name ?? target.name;

const arbiterNameOf = (arbiter: ArbiterClass): string =>
  arbiterOf(arbiter)?.options.name ?? arbiter.name;

const judgementOf = (instance: unknown, method: string): unknown =>
  typeof instance === "object" && instance !== null ? Reflect.get(instance, method) : undefined;

/** The check's answer, or `ABANDONED` when the launch is decided first (its rejection still handled). */
const ABANDONED = Symbol("abandoned");

function untilDecided(work: Promise<unknown>, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) return Promise.resolve(ABANDONED);
  return new Promise((resolve, reject) => {
    const leave = (): void => {
      resolve(ABANDONED);
    };
    signal.addEventListener("abort", leave, { once: true });
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", leave);
    });
  });
}

/** What a check ends with when its launch is decided before a model call it would make: its answer does not count. */
class Abandoned extends Error {}

/** The answer as the method reads it: tracked as given by its target (`Metadata.createdBy`, #1274). */
function trackedAnswer(answer: unknown, target: Class | undefined): unknown {
  if (target === undefined || typeof answer !== "object" || answer === null) return answer;
  if (Metadata.has(answer)) return answer;
  return Metadata.with(isTextAgent(target) ? asTextDto(answer) : answer, { createdBy: target });
}

/** A text agent (an `@Agent` without `output`) answers with its reply: a `WorkflowFinishTextDto` (#1283b). */
const isTextAgent = (target: Class): boolean => {
  const declaration = declarationOf(target);
  return declaration?.kind === ComponentKind.Agent && declaration.options.output === undefined;
};

/** The reply `{ text }` as the class the method's parameter names, so `answer instanceof WorkflowFinishTextDto` holds. */
function asTextDto(answer: object): object {
  return answer instanceof WorkflowFinishTextDto
    ? answer
    : Object.assign(Object.create(WorkflowFinishTextDto.prototype) as object, answer);
}

/** The method judging `site`'s target, with that target. */
function methodFor(arbiter: ArbiterClass, site: JudgedAnswer) {
  const method = answerMethodsOf(arbiter).find(({ targets }) =>
    targets.some((target) => nameOfTarget(target) === site.node),
  );
  if (method === undefined) throw new TypeError(`no @Arbitrate method for ${site.node}`);
  return { method, target: method.targets.find((one) => nameOfTarget(one) === site.node) };
}

/** A method with a model of its own is awaited for the calls it made (their cost is the branch's). */
async function byCodeWithModel(
  models: ArbiterModels,
  run: () => unknown,
  spent: UsageRecord[],
  deps: ArbiterDeps,
): Promise<unknown> {
  // once the launch is decided it asks no more
  const metered = models.metered({
    spent,
    reading: deps.reading,
    beforeCall: async () => {
      if (deps.signal.aborted) throw new Abandoned();
      await deps.beforeModelCall(spent);
    },
  });
  try {
    return await runArbiterCall(metered, run);
  } catch (error) {
    if (error instanceof Abandoned) return ABANDONED;
    throw error;
  }
}

async function byCode(
  arbiter: ArbiterClass,
  site: JudgedAnswer,
  spent: UsageRecord[],
  deps: ArbiterDeps,
): Promise<boolean> {
  const { method, target } = methodFor(arbiter, site);
  const instance = deps.instanceOf(arbiter);
  const judge = judgementOf(instance, method.method);
  if (typeof judge !== "function") throw new TypeError(`${method.method} is not a method`);
  const answer = trackedAnswer(site.answer, target);
  const options = arbiterOf(arbiter)?.options;
  const models =
    options !== undefined && hasArbiterModel(options) ? deps.modelOf?.(arbiter) : undefined;
  const run = (): unknown => Reflect.apply(judge, instance, [answer]);
  const passed =
    models === undefined
      ? await untilDecided(Promise.resolve().then(run), deps.signal)
      : await byCodeWithModel(models, run, spent, deps);
  // Stryker disable next-line BooleanLiteral: equivalent: a launch decided meanwhile ends the check whatever this arbiter said (`judgeAnswer` reads the signal first)
  if (passed === ABANDONED) return false;
  return booleanOf(passed, method.method);
}

function booleanOf(passed: unknown, method: string): boolean {
  if (typeof passed !== "boolean")
    throw new TypeError(`${method} returned ${String(passed)}, not true or false`);
  return passed;
}

async function byModel(
  arbiter: ArbiterClass,
  options: ModelArbiterOptions & { readonly name: string },
  site: JudgedAnswer,
  spent: UsageRecord[],
  deps: ArbiterDeps,
): Promise<boolean> {
  const criterion = options.criteria.find(({ target }) => nameOfTarget(target) === site.node);
  const model = deps.modelOf?.(arbiter);
  if (criterion === undefined) throw new TypeError(`no criterion for ${site.node}`);
  if (model === undefined) throw new TypeError(`no model for ${options.name}`);
  await deps.beforeModelCall(spent);
  // inline texts, sent normalised like every loaded prompt (#120)
  const criterionText = normalisePromptText(criterion.prompt);
  const question = { target: site.node, answer: site.answer, criterion: criterionText };
  const verdict = await model.judge(
    { ...question, instructions: model.instructions },
    deps.reading,
  );
  spent.push(...verdict.usage);
  if (verdict.kind === "failed")
    throw new StepError.Arbiter({
      arbiter: options.name,
      cause: verdict.cause ?? verdict.reason,
      usage: [...spent],
    });
  return verdict.passed;
}

/** The arbiter on the answer: whether it accepts; what its model calls spent lands in `spent` as it is billed. */
async function judgeOnce(
  arbiter: ArbiterClass,
  site: JudgedAnswer,
  spent: UsageRecord[],
  deps: ArbiterDeps,
): Promise<boolean> {
  const declaration = arbiterOf(arbiter);
  try {
    if (declaration === undefined) throw new TypeError(`${arbiter.name} is not an @Arbiter`);
    const { options } = declaration;
    return isCodeArbiter(options)
      ? await byCode(arbiter, site, spent, deps)
      : await byModel(arbiter, options, site, spent, deps);
  } catch (error) {
    if (passesThrough(error) || error instanceof StepError.Arbiter) throw error;
    throw new StepError.Arbiter({
      arbiter: arbiterNameOf(arbiter),
      cause: error,
      usage: [...spent],
    });
  }
}

/** Whether the arbiter is code, else a model (a class that is no `@Arbiter` counts as code: it fails in `judgeOnce`). */
const isCodeOf = (arbiter: ArbiterClass): boolean => {
  const declaration = arbiterOf(arbiter);
  return declaration === undefined || isCodeArbiter(declaration.options);
};

/** The launch's arbiter on one answer; an answer of a launch without one counts. */
export async function judgeAnswer(
  arbiter: ArbiterClass | undefined,
  site: JudgedAnswer,
  deps: ArbiterDeps,
): Promise<ChainVerdict> {
  const usage: UsageRecord[] = [];
  if (arbiter === undefined) return { isAccepted: true, rejectedBy: [], usage };
  const about = { arbiter: arbiterNameOf(arbiter), target: site.node, isCode: isCodeOf(arbiter) };
  try {
    const judged = await observedJudging(about, usage, async () => {
      const isAccepted = await judgeOnce(arbiter, site, usage, deps);
      return { isAccepted, isAbandoned: deps.signal.aborted };
    });
    if (judged.isAbandoned) return { isAccepted: false, rejectedBy: [], usage };
    const { isAccepted } = judged;
    return { isAccepted, rejectedBy: isAccepted ? [] : [arbiterNameOf(arbiter)], usage };
  } catch (error) {
    // a limit or a cancel ends the check with no verdict: its spend is kept by the branch (#1399)
    if (passesThrough(error)) deps.keepSpend?.(usage);
    throw error;
  }
}
