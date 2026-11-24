import { extractText } from "./multimodal-utils.js";
import { z } from "zod";
import { CostSource, NO_PROVIDER, ZERO_USAGE, type UsageRecord } from "../finops/usage.js";
import { billedDecisionRecord } from "../finops/failed-decision.js";
import { usd, type Usd } from "../units/index.js";
import type { JevClient } from "../llm/jev-client.js";
import { callFailed, decided, failed, unknownOption } from "./outcome.js";
import { jevRouteInstructions } from "./prompts.js";
import { routerCaller, type RouteOutcome, type RouteRequest, type RouterEngine } from "./types.js";

export interface JevRouterDeps {
  readonly name: string;
  readonly model: string;
  readonly client: JevClient;
  /** The provider the router's cascade resolved: its calls are recorded under it. */
  readonly provider?: string | undefined;
  /** Who answered, when a fallback did (#1313d): the call is recorded under that provider and model. */
  readonly servedBy?: (
    raw: unknown,
  ) => { readonly provider: string; readonly model: string } | undefined;
}

const JevResponseSchema = z.object({
  model: z.string().optional(),
  answers: z.object({
    route: z.object({
      choice: z.string(),
      confidence: z.number().optional(),
      probabilities: z.record(z.string(), z.number()).optional(),
    }),
  }),
  // a cost below zero would take spend off the budgets' counters: an invalid answer (#817)
  usage: z
    .object({
      cost: z.number().nonnegative().optional(),
      total_cost: z.number().nonnegative().optional(),
    })
    .optional(),
});

type JevResponse = z.infer<typeof JevResponseSchema>;
type JevRoute = JevResponse["answers"]["route"];

const reportedCost = (usage: JevResponse["usage"]): Usd =>
  usd(usage?.cost ?? usage?.total_cost ?? 0);

const scoreOf = (route: JevRoute): number | undefined =>
  route.probabilities?.[route.choice] ?? route.confidence;

function reasonFor(score: number | undefined): string {
  return score === undefined ? "jev" : `jev confidence ${score.toFixed(2)}`;
}

function toOutcome(
  raw: unknown,
  request: RouteRequest,
  usageOf: UsageFactory,
  billed: (raw: unknown, request: RouteRequest) => UsageRecord,
): RouteOutcome {
  const parsed = JevResponseSchema.safeParse(raw);
  // an answer the provider billed that is no usable decision: its spend is recorded once (#1399)
  if (!parsed.success) return failed("invalid router output", billed(raw, request));
  const { answers, usage, model } = parsed.data;
  const record = usageOf(model, reportedCost(usage));
  const { route } = answers;
  if (!request.options.some((option) => option.name === route.choice)) {
    return unknownOption(route.choice, record);
  }
  const score = scoreOf(route);
  const decision = { next: route.choice, reason: reasonFor(score) };
  return decided(score === undefined ? decision : { ...decision, confidence: score }, record);
}

type UsageFactory = (reportedModel: string | undefined, costUsd: Usd) => UsageRecord;

/** Jev picks among options with calibrated probabilities; cost comes from the API response. */
export function createJevRouter(deps: JevRouterDeps): RouterEngine {
  const usageFor =
    (served: { readonly provider: string; readonly model: string } | undefined): UsageFactory =>
    (reportedModel, costUsd) => ({
      caller: routerCaller(deps.name),
      model: reportedModel ?? served?.model ?? deps.model,
      provider: served?.provider ?? deps.provider ?? NO_PROVIDER,
      ...ZERO_USAGE,
      costUsd,
      costSource: CostSource.Api,
    });
  const billed = (raw: unknown, request: RouteRequest): UsageRecord =>
    billedDecisionRecord(
      {
        caller: routerCaller(deps.name),
        model: deps.servedBy?.(raw)?.model ?? deps.model,
        provider: deps.servedBy?.(raw)?.provider ?? deps.provider,
      },
      { input: extractText(request.input), options: request.options },
      raw,
    );
  return {
    name: deps.name,
    route: async (request) => {
      const criteria = Object.fromEntries(request.options.map((o) => [o.name, o.description]));
      try {
        const raw = await deps.client({
          model: deps.model,
          state: extractText(request.input),
          questions: {
            route: {
              type: "choice",
              instructions: request.instructions ?? jevRouteInstructions,
              criteria,
            },
          },
        });
        return toOutcome(raw, request, usageFor(deps.servedBy?.(raw)), billed);
      } catch (error) {
        return callFailed(error, usageFor(undefined)(undefined, usd(0)));
      }
    },
  };
}
