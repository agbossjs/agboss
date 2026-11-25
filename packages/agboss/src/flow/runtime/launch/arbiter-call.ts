import { ConfigError } from "../../../core/error-families/config-errors.js";
import { chatMessagesOf } from "../../../models/messages.js";
import { HumanMessage } from "@langchain/core/messages";
import type { ResolvedModelSettings, RouterModel } from "../../../config/types.js";
import { chargedCall } from "../../../finops/charged-call.js";
import { decisionSpendOf } from "../../../finops/failed-decision.js";
import { recordUsage, type UsageRecord } from "../../../finops/usage.js";
import { lazyLoad } from "../../../infrastructure/clock.js";
import { ModelKind } from "../../../llm/decision-errors.js";
import type { AnswersOf, DecisionQuestions, DecisionRequest } from "../../../llm/decisions.js";
import { resolveSettings } from "../../../llm/registry.js";
import type { ModelReadingMask } from "../../../pii/model-boundary.js";
import type { ArbiterModel } from "../../decorators/arbiter.js";
import {
  arbiterCaller,
  createArbiterModel,
  type DeclarativeArbiterModel,
} from "./arbiter-model.js";
import type { LaunchDeciderDeps } from "./launch-decider.js";

/**
 * The metered model behind the injected `ArbiterModel` of a code arbiter (#1283, `arbiter-live.ts`):
 * its `invoke` / `decide` go through the gateway, under the cost caller `arbiter:<name>`. Every call
 * checks the execution's budgets first, and what it spent — a failed call's partial spend too
 * (#1399) — goes into the answer's spend (`ArbiterCall.spent`).
 */

/** What one judged answer's model calls run on. */
export interface ArbiterCall {
  /** Where the calls' spend goes, as it is billed (a failed call's partial spend too). */
  readonly spent: UsageRecord[];
  /** How the model reads the answer (#708): the answering target's PII policies. */
  readonly reading?: ModelReadingMask | undefined;
  /** The execution's budgets checked before each model call; throws when one is spent. */
  readonly beforeCall: () => Promise<void>;
}

/** A model arbiter's two uses: its declarative `criteria` judging, and the injectable model of its code. */
export interface ArbiterModels extends DeclarativeArbiterModel {
  /** The arbiter's `prompt` as assembly read it: how its model judges (#1347). */
  readonly instructions: string;
  /** The `ArbiterModel` of one judged answer, its spend into `call.spent`. */
  readonly metered: (call: ArbiterCall) => ArbiterModel;
}

/** A reading of a call's texts (#708), loaded on first use: only an answer with PII policies needs it. */
async function readingOf(mask: ModelReadingMask) {
  const { JudgeReading } = await lazyLoad(import("../../../graph/agent-loop/judge-reading.js"));
  return new JudgeReading(mask);
}

/** `arbiterModel.invoke`: one chat call; a decision model cannot chat. */
function invokeOf(
  name: string,
  model: RouterModel,
  deps: LaunchDeciderDeps,
  call: ArbiterCall,
): ArbiterModel["invoke"] {
  return async (asGiven) => {
    const given = typeof asGiven === "string" ? asGiven : chatMessagesOf(asGiven);
    if (model.kind !== "llm")
      throw new ConfigError.ModelKind({
        model: model.model,
        modelKind: ModelKind.Decisions,
        call: "invoke",
      });
    const caller = arbiterCaller(name);
    const settings: ResolvedModelSettings = resolveSettings(model, deps.chatDefaults);
    await call.beforeCall(); // a budget of the execution that is spent stops the arbiter before this call
    const reading = call.reading === undefined ? undefined : await readingOf(call.reading);
    const sent = reading === undefined ? given : await reading.input(given);
    call.spent.push(...(reading?.usage ?? []));
    const asked = typeof sent === "string" ? [new HumanMessage(sent)] : [...sent];
    const chat = deps.gateway.chatModel({ user: { kind: "arbiter", arbiter: name }, settings });
    const spec = {
      caller,
      settings,
      sent: asked,
      sink: (r: readonly UsageRecord[]) => call.spent.push(...r),
    };
    const reply = await chargedCall(spec, (callbacks) => chat.invoke(asked, { callbacks }));
    call.spent.push(recordUsage(caller, settings, reply));
    return reading === undefined ? reply.text : reading.revealed(reply.text);
  };
}

/** `arbiterModel.decide`: one decision; a chat model cannot decide. */
function decideOf(
  name: string,
  model: RouterModel,
  deps: LaunchDeciderDeps,
  call: ArbiterCall,
): ArbiterModel["decide"] {
  return async <const Q extends DecisionQuestions>(
    request: DecisionRequest<Q>,
  ): Promise<AnswersOf<Q>> => {
    if (model.kind !== "jev")
      throw new ConfigError.ModelKind({
        model: model.model,
        modelKind: ModelKind.Chat,
        call: "decide",
      });
    const { gateway } = deps;
    if (gateway.decide === undefined)
      throw new TypeError(
        `${arbiterCaller(name)}: the model gateway has no decisions (${model.model})`,
      );
    await call.beforeCall(); // a budget of the execution that is spent stops the arbiter before this call
    const reading = call.reading === undefined ? undefined : await readingOf(call.reading);
    const sent = reading === undefined ? request : await reading.request(request);
    call.spent.push(...(reading?.usage ?? []));
    const outcome = await gateway
      .decide({
        caller: arbiterCaller(name),
        model: model.model,
        ...(model.modelProvider === undefined ? {} : { modelProvider: model.modelProvider }),
        request: sent,
      })
      .catch((error: unknown) => {
        const billed = decisionSpendOf(error);
        if (billed !== undefined) call.spent.push(billed); // an answer it billed and could not use (#1399)
        throw error;
      });
    call.spent.push(outcome.usage);
    // validated against these very questions by the gateway: each id answered with its own type
    return outcome.answers as AnswersOf<Q>;
  };
}

/** The model arbiter `name` on its model: judging by `criteria`, and the `ArbiterModel` its code injects. */
export function createArbiterModels(
  name: string,
  model: RouterModel,
  deps: LaunchDeciderDeps,
  instructions: string,
): ArbiterModels {
  return {
    ...createArbiterModel(name, model, deps),
    instructions,
    metered: (call) => ({
      model: model.model,
      invoke: invokeOf(name, model, deps, call),
      decide: decideOf(name, model, deps, call),
    }),
  };
}
