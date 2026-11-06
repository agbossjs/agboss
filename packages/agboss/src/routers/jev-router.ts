import { extractText } from "./multimodal-utils.js";
import { z } from "zod";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../finops/usage.js";
import type { JevClient } from "../llm/jev-client.js";
import { callFailed, decided, failed, unknownOption } from "./outcome.js";
import { jevRouteInstructions } from "./prompts.js";
import { routerCaller, type RouteOutcome, type RouteRequest, type RouterEngine } from "./types.js";

export interface JevRouterDeps {
  readonly name: string;
  readonly model: string;
  readonly client: JevClient;
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
  usage: z.object({ cost: z.number().optional(), total_cost: z.number().optional() }).optional(),
});

type JevResponse = z.infer<typeof JevResponseSchema>;
type JevRoute = JevResponse["answers"]["route"];

const reportedCost = (usage: JevResponse["usage"]): number => usage?.cost ?? usage?.total_cost ?? 0;

const scoreOf = (route: JevRoute): number | undefined =>
  route.probabilities?.[route.choice] ?? route.confidence;

function reasonFor(score: number | undefined): string {
  return score === undefined ? "jev" : `jev confidence ${score.toFixed(2)}`;
}

function toOutcome(raw: unknown, request: RouteRequest, usageOf: UsageFactory): RouteOutcome {
  const parsed = JevResponseSchema.safeParse(raw);
  if (!parsed.success) return failed("invalid router output", usageOf(undefined, 0));
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

type UsageFactory = (reportedModel: string | undefined, costUsd: number) => UsageRecord;

/** Jev picks among options with calibrated probabilities; cost comes from the API response. */
export function createJevRouter(deps: JevRouterDeps): RouterEngine {
  const usageOf: UsageFactory = (reportedModel, costUsd) => ({
    caller: routerCaller(deps.name),
    model: reportedModel ?? deps.model,
    ...ZERO_USAGE,
    costUsd,
    costSource: CostSource.Api,
  });
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
        return toOutcome(raw, request, usageOf);
      } catch (error) {
        return callFailed(error, usageOf(undefined, 0));
      }
    },
  };
}
