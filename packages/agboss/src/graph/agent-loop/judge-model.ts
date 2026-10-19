import type { BaseMessageLike } from "@langchain/core/messages";
import type { JudgeModel } from "../../components/judge-decorators.js";
import { recordUsage, type UsageRecord } from "../../finops/usage.js";
import { ModelKind, ModelKindError } from "../../llm/decision-errors.js";
import type { AnswersOf, DecisionQuestions, DecisionRequest } from "../../llm/decisions.js";
import type { JudgeBinding } from "../../llm/registry.js";
import type { AgentJudge } from "./deps.js";

/** The cost caller of a judge's model calls (category `review`). */
const judgeCaller = (judge: string): string => `judge:${judge}`;

/** `ctx.model.invoke`: one chat call on a chat judge's model; a decision model cannot chat. */
function invokeOf(
  judge: string,
  binding: JudgeBinding,
  spent: UsageRecord[],
): JudgeModel["invoke"] {
  return async (input: string | readonly BaseMessageLike[]) => {
    if (binding.kind !== ModelKind.Chat) {
      throw new ModelKindError(binding.model, ModelKind.Decisions, "invoke");
    }
    const { model, settings } = binding.chat;
    const response = await model.invoke(typeof input === "string" ? input : [...input]);
    spent.push(recordUsage(judgeCaller(judge), settings, response));
    return response.text;
  };
}

/** `ctx.model.decide`: one decision on a decision judge's model; a chat model cannot decide. */
function decideOf(binding: JudgeBinding, spent: UsageRecord[]): JudgeModel["decide"] {
  return async <const Q extends DecisionQuestions>(
    request: DecisionRequest<Q>,
  ): Promise<AnswersOf<Q>> => {
    if (binding.kind !== ModelKind.Decisions) {
      throw new ModelKindError(binding.model, ModelKind.Chat, "decide");
    }
    const outcome = await binding.decide(request);
    spent.push(outcome.usage);
    // validated against these very questions (readDecision): each id answered with its own type
    return outcome.answers as AnswersOf<Q>;
  };
}

/** A judge's model: each call through the gateway, its spend added to `spent`. */
export function meteredModel(
  judge: Pick<AgentJudge, "name" | "binding">,
  spent: UsageRecord[],
): JudgeModel {
  return {
    model: judge.binding.model,
    invoke: invokeOf(judge.name, judge.binding, spent),
    decide: decideOf(judge.binding, spent),
  };
}
