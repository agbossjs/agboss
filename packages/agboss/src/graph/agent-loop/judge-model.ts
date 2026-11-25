import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { chatMessagesOf, type ModelMessage } from "../../models/messages.js";
import { decisionStateWith } from "../../files/decision-parts.js";
import { contentWithPieces, type FilePiece } from "../../files/file-pieces.js";
import type { JudgeModel } from "../../components/judge-decorators.js";
import { ComponentError } from "../../components/metadata.js";
import { recordUsage, type UsageRecord } from "../../finops/usage.js";
import { ModelKind, ModelKindError } from "../../llm/decision-errors.js";
import type { AnswersOf, DecisionQuestions, DecisionRequest } from "../../llm/decisions.js";
import type { JudgeBinding } from "../../llm/registry.js";
import type { AgentJudge } from "./deps.js";
import type { ModelReadingMask } from "../../pii/model-boundary.js";
import { lazyLoad } from "../../infrastructure/clock.js";
import { decisionSpendOf } from "../../finops/failed-decision.js";
import { chargedCall } from "../../finops/charged-call.js";

/** A judge's reading (#708), loaded on its first use: only an agent with PII policies needs it. */
async function judgeReadingOf(mask: ModelReadingMask) {
  const { JudgeReading } = await lazyLoad(import("./judge-reading.js"));
  return new JudgeReading(mask);
}

/** What runs right before each model call of a judge: the budgets' check (#1290), throwing when spent. */
export type BeforeCall = () => void | Promise<void>;

const NO_CHECK: BeforeCall = () => undefined;

/** The cost caller of a judge's model calls (category `review`). */
const judgeCaller = (judge: string): string => `judge:${judge}`;

/** What a judge asks its chat model with the files the agent's model read after it (#899 §8). */
function withPiecesIn(
  input: string | readonly BaseMessage[],
  pieces: readonly FilePiece[],
): string | readonly BaseMessage[] {
  if (pieces.length === 0) return input;
  const files = new HumanMessage({ content: contentWithPieces("", pieces) });
  return typeof input === "string"
    ? [new HumanMessage({ content: contentWithPieces(input, pieces) })]
    : [...input, files];
}

/** `ctx.model.invoke`: one chat call on a chat judge's model; a decision model cannot chat. */
function invokeOf(
  judge: string,
  binding: JudgeBinding,
  spent: UsageRecord[],
  mask: ModelReadingMask | undefined,
  pieces: readonly FilePiece[],
  beforeCall: BeforeCall,
): JudgeModel["invoke"] {
  return async (given: string | readonly ModelMessage[]) => {
    const input = withPiecesIn(typeof given === "string" ? given : chatMessagesOf(given), pieces);
    if (binding.kind !== ModelKind.Chat) {
      throw new ModelKindError({ model: binding.model, kind: ModelKind.Decisions, call: "invoke" });
    }
    const { model, settings } = binding.chat;
    await beforeCall(); // a budget of the execution that is spent stops the judge before this call
    const reading = mask === undefined ? undefined : await judgeReadingOf(mask);
    const sent = reading === undefined ? input : await reading.input(input);
    spent.push(...(reading?.usage ?? []));
    const asked = typeof sent === "string" ? sent : [...sent];
    const spec = {
      caller: judgeCaller(judge),
      settings,
      sent: asked,
      sink: (records: readonly UsageRecord[]) => spent.push(...records),
    };
    const response = await chargedCall(spec, (callbacks) => model.invoke(asked, { callbacks }));
    spent.push(recordUsage(judgeCaller(judge), settings, response));
    return reading === undefined ? response.text : reading.revealed(response.text);
  };
}

/** `ctx.model.decide`: one decision on a decision judge's model; a chat model cannot decide. */
function decideOf(
  judge: string,
  binding: JudgeBinding,
  spent: UsageRecord[],
  mask: ModelReadingMask | undefined,
  pieces: readonly FilePiece[],
  beforeCall: BeforeCall,
): JudgeModel["decide"] {
  return async <const Q extends DecisionQuestions>(
    request: DecisionRequest<Q>,
  ): Promise<AnswersOf<Q>> => {
    if (binding.kind !== ModelKind.Decisions) {
      throw new ModelKindError({ model: binding.model, kind: ModelKind.Chat, call: "decide" });
    }
    await beforeCall(); // a budget of the execution that is spent stops the judge before this call
    const reading = mask === undefined ? undefined : await judgeReadingOf(mask);
    const asked = {
      ...request,
      state: decisionStateWith(request.state, pieces, {
        caller: judgeCaller(judge),
        model: binding.model,
      }),
    };
    const sent = reading === undefined ? asked : await reading.request(asked);
    spent.push(...(reading?.usage ?? []));
    const outcome = await binding.decide(sent).catch((error: unknown) => {
      const billed = decisionSpendOf(error);
      if (billed !== undefined) spent.push(billed); // an answer it billed and could not use (#1399)
      throw error;
    });
    spent.push(outcome.usage);
    // validated against these very questions (readDecision): each id answered with its own type
    return outcome.answers as AnswersOf<Q>;
  };
}

/** The model of a code judge (#396): it has none, so every call is a mistake, named. */
function noModelOf(judge: string): JudgeModel {
  const refuse = (member: string): never => {
    throw new ComponentError({
      message: `[judge.model-on-code-judge] judge "${judge}" is decided by code and has no model — judgeModel.${member} is not available`,
    });
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
  pieces: readonly FilePiece[] = [],
  beforeCall: BeforeCall = NO_CHECK,
): JudgeModel {
  const { binding } = judge;
  if (binding === undefined) return noModelOf(judge.name);
  return {
    model: binding.model,
    invoke: invokeOf(judge.name, binding, spent, mask, pieces, beforeCall),
    decide: decideOf(judge.name, binding, spent, mask, pieces, beforeCall),
  };
}
