import type { Class } from "../../../components/injection.js";
import { normalisePromptText } from "../../../components/prompt-render.js";
import type { UsageRecord } from "../../../finops/usage.js";
import type { AcceptedBy, ArbiterClass } from "../../ast.js";
import {
  answerMethodsOf,
  arbiterOf,
  isCodeArbiter,
  type ModelArbiterOptions,
} from "../../decorators/arbiter.js";
import { declarationOf } from "../../decorators/declaration.js";
import { passesThrough } from "../errors.js";
import type { ArbiterModel } from "./arbiter-model.js";
import { ArbiterError } from "./quorum-errors.js";

/**
 * The arbiter chain of a branch (#279 AC12, S57): run inside the branch, under its slot and in its
 * frame, on the answer its agent gave. The `.acceptedBy(…)` steps are an AND in path order — the
 * first rejection stops the chain, later arbiters are not called; inside `anyOf(A, B)` the arbiters
 * run in order and the first that accepts accepts. A code arbiter's `@OnAnswer(Agent)` method gets
 * the plain answer; a model arbiter asks its model with the agent's criterion. An arbiter that throws,
 * returns something other than a boolean or whose model does not answer fails the branch with
 * `ArbiterError` — never a rejection. A limit or a cancel passes through as it is. Once the launch is
 * decided (its signal aborted) the chain stops: a running code check is abandoned at once; a model
 * check's call, which cannot be stopped, is awaited for its cost — either way the answer does not
 * count (the caller sees the aborted signal).
 */

/** What the chain runs on: the arbiters' instances and models, and the limits before a model call. */
export interface ArbiterDeps {
  /** A code arbiter's instance, from the application's container. */
  readonly instanceOf: (arbiter: Class) => unknown;
  /** A model arbiter's model. */
  readonly modelOf?: (arbiter: ArbiterClass) => ArbiterModel | undefined;
  /** Checks the execution's budgets before a model call, with what the chain spent so far. */
  readonly beforeModelCall: (spent: readonly UsageRecord[]) => Promise<void>;
  /** The launch's signal: aborted once the quorum is decided. */
  readonly signal: AbortSignal;
}

/** The answer judged: the branch's node and its value. */
export interface JudgedAnswer {
  readonly node: string;
  readonly answer: unknown;
}

/** What the chain decided, what it cost, and who rejected (every arbiter of the failed step). */
export interface ChainVerdict {
  readonly isAccepted: boolean;
  readonly rejectedBy: readonly string[];
  readonly usage: readonly UsageRecord[];
}

const nameOfAgent = (agent: Class): string => declarationOf(agent)?.options.name ?? agent.name;

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

async function byCode(arbiter: ArbiterClass, site: JudgedAnswer, deps: ArbiterDeps) {
  const method = answerMethodsOf(arbiter).find(({ agent }) => nameOfAgent(agent) === site.node);
  if (method === undefined) throw new TypeError(`no @OnAnswer method for ${site.node}`);
  const instance = deps.instanceOf(arbiter);
  const judge = judgementOf(instance, method.method);
  if (typeof judge !== "function") throw new TypeError(`${method.method} is not a method`);
  const work = Promise.resolve().then((): unknown => Reflect.apply(judge, instance, [site.answer]));
  const passed = await untilDecided(work, deps.signal);
  if (passed === ABANDONED) return { passed: false, usage: [] };
  if (typeof passed !== "boolean")
    throw new TypeError(`${method.method} returned ${String(passed)}, not true or false`);
  return { passed, usage: [] };
}

async function byModel(
  arbiter: ArbiterClass,
  options: ModelArbiterOptions,
  site: JudgedAnswer,
  spent: readonly UsageRecord[],
  deps: ArbiterDeps,
) {
  const criterion = options.criteria.find(({ agent }) => nameOfAgent(agent) === site.node);
  const model = deps.modelOf?.(arbiter);
  if (criterion === undefined) throw new TypeError(`no criterion for ${site.node}`);
  if (model === undefined) throw new TypeError(`no model for ${options.name}`);
  await deps.beforeModelCall(spent);
  // inline texts, sent normalised like every loaded prompt (#120)
  const criterionText = normalisePromptText(criterion.prompt);
  const question = { agent: site.node, answer: site.answer, criterion: criterionText };
  const verdict = await model.judge({
    ...question,
    instructions: normalisePromptText(options.prompt),
  });
  if (verdict.kind === "failed")
    throw new ArbiterError(options.name, verdict.cause ?? verdict.reason, [
      ...spent,
      ...verdict.usage,
    ]);
  return { passed: verdict.passed, usage: verdict.usage };
}

/** One arbiter on the answer: whether it accepts, and what its model call cost. */
async function judgeOnce(
  arbiter: ArbiterClass,
  site: JudgedAnswer,
  spent: readonly UsageRecord[],
  deps: ArbiterDeps,
): Promise<{ readonly passed: boolean; readonly usage: readonly UsageRecord[] }> {
  const declaration = arbiterOf(arbiter);
  try {
    if (declaration === undefined) throw new TypeError(`${arbiter.name} is not an @Arbiter`);
    const { options } = declaration;
    return isCodeArbiter(options)
      ? await byCode(arbiter, site, deps)
      : await byModel(arbiter, options, site, spent, deps);
  } catch (error) {
    if (passesThrough(error) || error instanceof ArbiterError) throw error;
    throw new ArbiterError(arbiterNameOf(arbiter), error, spent);
  }
}

/** The chain on one answer: AND over the steps in path order, `anyOf` inside a step. */
export async function judgeAnswer(
  chain: readonly AcceptedBy[],
  site: JudgedAnswer,
  deps: ArbiterDeps,
): Promise<ChainVerdict> {
  const usage: UsageRecord[] = [];
  for (const step of chain) {
    const rejectedBy: string[] = [];
    let isAccepted = false;
    for (const arbiter of step.arbiters) {
      const judged = await judgeOnce(arbiter, site, usage, deps);
      usage.push(...judged.usage);
      if (deps.signal.aborted) return { isAccepted: false, rejectedBy: [], usage };
      if (judged.passed) {
        isAccepted = true;
        break;
      }
      rejectedBy.push(arbiterNameOf(arbiter));
    }
    if (!isAccepted) return { isAccepted, rejectedBy, usage };
  }
  return { isAccepted: true, rejectedBy: [], usage };
}
