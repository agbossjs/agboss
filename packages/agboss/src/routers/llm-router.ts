import { ConfigError } from "../core/error-families/config-errors.js";
import { mergeTextWithContent } from "./multimodal-utils.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ResolvedModelSettings } from "../config/types.js";
import type { AIMessageChunk } from "@langchain/core/messages";
import { recordUsage, unpricedUsageOf } from "../finops/usage.js";
import { compareNames } from "../llm/canonical-order.js";
import { readRouterDecision, type ParsedDecision } from "./decision.js";
import { callFailed, decided, failed, unknownOption } from "./outcome.js";
import { llmRouterPrompt } from "./prompts.js";
import {
  routerCaller,
  withSpent,
  type RouteOption,
  type RouteOutcome,
  type RouterEngine,
} from "./types.js";
import type { UsageRecord } from "../finops/usage.js";
import { chargedCall, frameOrCollected } from "../finops/charged-call.js";

export interface LlmRouterDeps {
  readonly name: string;
  readonly model: BaseChatModel;
  readonly settings: ResolvedModelSettings;
}

const describeOptions = (options: readonly RouteOption[]): string =>
  options.map((option) => `- ${option.name}: ${option.description}`).join("\n");

function outcomeOf(read: ParsedDecision, usage: UsageRecord): RouteOutcome {
  switch (read.kind) {
    case "valid":
      return decided(read.decision, usage);
    case "unknown-option":
      return unknownOption(read.option, usage);
    case "invalid":
      return failed("invalid router output", usage);
  }
}

/** A call that failed before an answer is recorded at no cost (what it streamed is the sink's, #1399). */
const NO_CALL_COST = { response_metadata: { usage: { cost: 0 } } };

/**
 * The record of a router call that failed: at no cost when no answer came; when the provider answered
 * — and billed — and only its accounting failed, the answer's tokens, unpriced (bughunt 2026-11-25 #2).
 */
function failedCallUsageOf(
  caller: string,
  deps: LlmRouterDeps,
  answered: AIMessageChunk | undefined,
): UsageRecord {
  if (answered === undefined) return recordUsage(caller, deps.settings, NO_CALL_COST);
  try {
    return recordUsage(caller, deps.settings, answered);
  } catch (failure) {
    if (!(failure instanceof ConfigError.ModelCost)) throw failure;
    return unpricedUsageOf(caller, deps.settings, answered);
  }
}

/** Chat model asked for JSON; output validated with zod; priced by its provider's table. */

export function createLlmRouter(deps: LlmRouterDeps): RouterEngine {
  const caller = routerCaller(deps.name);
  return {
    name: deps.name,
    route: async (request) => {
      const { sink, collected } = frameOrCollected();
      let answered: AIMessageChunk | undefined;
      try {
        const prompt = await llmRouterPrompt.formatMessages({
          // routes in a canonical order (by name): declaration order changes neither request nor fingerprint
          options: describeOptions(
            [...request.options].sort((a, b) => compareNames(a.name, b.name)),
          ),
          input:
            request.instructions === undefined
              ? request.input
              : mergeTextWithContent(`${request.instructions}\n\n`, request.input),
        });
        const spec = { caller, settings: deps.settings, sent: prompt, sink };
        answered = await chargedCall(spec, (callbacks) => deps.model.invoke(prompt, { callbacks }));
        const usage = recordUsage(caller, deps.settings, answered);
        const allowed = new Set(request.options.map((option) => option.name));
        return withSpent(outcomeOf(readRouterDecision(answered.text, allowed), usage), collected);
      } catch (error) {
        return withSpent(callFailed(error, failedCallUsageOf(caller, deps, answered)), collected);
      }
    },
  };
}
