import { z } from "zod";
import { NO_PROVIDER } from "./no-provider.js";
import { usd } from "../units/index.js";
import { CostSource } from "./cost-source.js";
import { ZERO_USAGE, type UsageRecord } from "./usage.js";

/**
 * The spend of a decision call that failed (#1399). A decision is one request and one answer, no
 * stream: once the provider answered, it billed the call, whether or not the answer fits the questions
 * asked. What it reported (`usage`) is recorded; else the tokens are estimated from the sizes of the
 * request and of the answer (4 characters a token), unpriced. A call that got no answer at all (the
 * network, a refusal status) has nothing to record.
 */

const CHARS_PER_TOKEN = 4;
const tokensOfChars = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

const ReportedUsage = z.object({
  model: z.string().optional(),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
      cost: z.number().nonnegative().optional(),
    })
    .optional(),
});

/** What a decision call was, for the record: its caller, its model and the provider its cascade resolved. */
export interface DecisionCall {
  readonly caller: string;
  readonly model: string;
  readonly provider?: string | undefined;
}

const sizeOf = (value: unknown): number => {
  try {
    // `undefined` and a function stringify to nothing: no `length` to read, counted as none
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
};

type Reported = NonNullable<z.infer<typeof ReportedUsage>["usage"]>;

/** The record of a call whose cost the provider reported: its tokens as it counted them. */
const reportedRecord = (base: UsageRecordBase, reported: Reported, cost: number): UsageRecord => ({
  ...base,
  inputTokens: reported.input_tokens ?? 0,
  outputTokens: reported.output_tokens ?? 0,
  costUsd: usd(cost),
  costSource: CostSource.Api,
});

type UsageRecordBase = Omit<UsageRecord, "costUsd" | "costSource">;

/** The record of a call whose provider reported no cost: its tokens as reported, else estimated; unpriced. */
function estimatedRecord(
  base: UsageRecordBase,
  reported: Reported | undefined,
  sizes: { readonly request: number; readonly response: number },
): UsageRecord {
  return {
    ...base,
    inputTokens: reported?.input_tokens ?? tokensOfChars(sizes.request),
    outputTokens: reported?.output_tokens ?? tokensOfChars(sizes.response),
    costUsd: usd(0),
    costSource: CostSource.Unpriced,
  };
}

/**
 * The one record of a decision the provider answered and the caller could not use: the provider's
 * report (its cost is `CostSource.Api`), else the estimated tokens, `CostSource.Unpriced`.
 */
export function billedDecisionRecord(
  call: DecisionCall,
  request: unknown,
  response: unknown,
): UsageRecord {
  const parsed = ReportedUsage.safeParse(response);
  const data = parsed.success ? parsed.data : undefined;
  const base = {
    caller: call.caller,
    model: data?.model ?? call.model,
    ...ZERO_USAGE,
    provider: call.provider ?? NO_PROVIDER,
  };
  const reported = data?.usage;
  return reported?.cost !== undefined
    ? reportedRecord(base, reported, reported.cost)
    : estimatedRecord(base, reported, { request: sizeOf(request), response: sizeOf(response) });
}

const spends = new WeakMap<object, UsageRecord>();

/** `error` carrying the record of what its failed decision call spent (a non-object is wrapped). */
export function withDecisionSpend(error: unknown, record: UsageRecord): unknown {
  const carrier: object =
    typeof error === "object" && error !== null
      ? error
      : new Error(String(error), { cause: error });
  spends.set(carrier, record);
  return carrier;
}

/** The record a failed decision call carries: the error's, or one of its causes'. */
export function decisionSpendOf(error: unknown): UsageRecord | undefined {
  // a cause that is no object is no key of the map: its read gives none, and it has no cause to follow
  for (
    let cause: unknown = error;
    cause !== undefined;
    cause = cause instanceof Error ? cause.cause : undefined
  ) {
    const found = spends.get(cause as object);
    if (found !== undefined) return found;
  }
  return undefined;
}
