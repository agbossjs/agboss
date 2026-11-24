import { mergeTextWithContent } from "./multimodal-utils.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ResolvedModelSettings } from "../config/types.js";
import { recordUsage } from "../finops/usage.js";
import { compareNames } from "../llm/canonical-order.js";
import { readRouterDecision, type ParsedDecision } from "./decision.js";
import { callFailed, decided, failed, unknownOption } from "./outcome.js";
import { llmRouterPrompt } from "./prompts.js";
import { routerCaller, type RouteOption, type RouteOutcome, type RouterEngine } from "./types.js";
import type { UsageRecord } from "../finops/usage.js";
import { chargedCall, reportToFrame } from "../finops/charged-call.js";

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

/** Chat model asked for JSON; output validated with zod; priced from the config table. */
/** A call that failed before an replyWith is recorded at no cost. */
const NO_CALL_COST = { response_metadata: { usage: { cost: 0 } } };

export function createLlmRouter(deps: LlmRouterDeps): RouterEngine {
  const caller = routerCaller(deps.name);
  return {
    name: deps.name,
    route: async (request) => {
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
        const spec = { caller, settings: deps.settings, sent: prompt, sink: reportToFrame };
        const response = await chargedCall(spec, (callbacks) =>
          deps.model.invoke(prompt, { callbacks }),
        );
        const usage = recordUsage(caller, deps.settings, response);
        const allowed = new Set(request.options.map((option) => option.name));
        return outcomeOf(readRouterDecision(response.text, allowed), usage);
      } catch (error) {
        return callFailed(error, recordUsage(caller, deps.settings, NO_CALL_COST));
      }
    },
  };
}
