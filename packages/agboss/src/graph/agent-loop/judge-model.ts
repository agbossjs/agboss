import type { BaseMessageLike } from "@langchain/core/messages";
import type { JudgeModel } from "../../components/judge-decorators.js";
import { ComponentError } from "../../components/metadata.js";
import { recordUsage, type UsageRecord } from "../../finops/usage.js";
import { ModelKind, ModelKindError } from "../../llm/decision-errors.js";
import type { AnswersOf, DecisionQuestions, DecisionRequest } from "../../llm/decisions.js";
import type { JudgeBinding } from "../../llm/registry.js";
import type { AgentJudge } from "./deps.js";
import type { ModelReadingMask } from "../../pii/model-boundary.js";
import { lazyLoad } from "../../infrastructure/clock.js";

/** A judge's reading (#708), loaded on its first use: only an agent with PII policies needs it. */
async function judgeReadingOf(mask: ModelReadingMask) {
  const { JudgeReading } = await lazyLoad(import("./judge-reading.js"));
  return new JudgeReading(mask);
}

/** The cost caller of a judge's model calls (category `review`). */
const judgeCaller = (judge: string): string => `judge:${judge}`;

/** `ctx.model.invoke`: one chat call on a chat judge's model; a decision model cannot chat. */
function invokeOf(
  judge: string,
  binding: JudgeBinding,
  spent: UsageRecord[],
  mask: ModelReadingMask | undefined,
): JudgeModel["invoke"] {
  return async (input: string | readonly BaseMessageLike[]) => {
    if (binding.kind !== ModelKind.Chat) {
      throw new ModelKindError({ model: binding.model, kind: ModelKind.Decisions, call: "invoke" });
    }
    const { model, settings } = binding.chat;
    const reading = mask === undefined ? undefined : await judgeReadingOf(mask);
    const sent = reading === undefined ? input : await reading.input(input);
    spent.push(...(reading?.usage ?? []));
    const response = await model.invoke(typeof sent === "string" ? sent : [...sent]);
    spent.push(recordUsage(judgeCaller(judge), settings, response));
    return reading === undefined ? response.text : reading.revealed(response.text);
  };
}

/** `ctx.model.decide`: one decision on a decision judge's model; a chat model cannot decide. */
function decideOf(
  binding: JudgeBinding,
  spent: UsageRecord[],
  mask: ModelReadingMask | undefined,
): JudgeModel["decide"] {
  return async <const Q extends DecisionQuestions>(
    request: DecisionRequest<Q>,
  ): Promise<AnswersOf<Q>> => {
    if (binding.kind !== ModelKind.Decisions) {
      throw new ModelKindError({ model: binding.model, kind: ModelKind.Chat, call: "decide" });
    }
    const reading = mask === undefined ? undefined : await judgeReadingOf(mask);
    const sent = reading === undefined ? request : await reading.request(request);
    spent.push(...(reading?.usage ?? []));
    const outcome = await binding.decide(sent);
    spent.push(outcome.usage);
    // validated against these very questions (readDecision): each id answered with its own type
    return outcome.answers as AnswersOf<Q>;
  };
}

/** The model of a code judge (#396): it has none, so every call is a mistake, named. */
function noModelOf(judge: string): JudgeModel {
  const refuse = (member: string): never => {
    throw new ComponentError(
      `[judge.model-on-code-judge] judge "${judge}" is decided by code (DecidedBy.Code) and has no model — judgeModel.${member} is not available`,
    );
  };
  return {
    get model(): string {
      return refuse("model");
    },
    invoke: () => Promise.resolve().then(() => refuse("invoke")),
    decide: () => Promise.resolve().then(() => refuse("decide")),
  };
}

/**
 * A judge's model: each call through the gateway, its spend added to `spent`; none for a code
 * judge. In an agent's quality gate its calls read as the agent's model reads (`mask`, #708).
 */
export function meteredModel(
  judge: Pick<AgentJudge, "name" | "binding">,
  spent: UsageRecord[],
  mask?: ModelReadingMask,
): JudgeModel {
  const { binding } = judge;
  if (binding === undefined) return noModelOf(judge.name);
  return {
    model: binding.model,
    invoke: invokeOf(judge.name, binding, spent, mask),
    decide: decideOf(binding, spent, mask),
  };
}
