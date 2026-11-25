import type { Callbacks } from "@langchain/core/callbacks/manager";
import { ensureConfig } from "@langchain/core/runnables";
import { currentFrame } from "../flow/context/frame.js";
import { ChunkCounter, withChunkCounter } from "../graph/agent-loop/chunk-counter.js";
import type { ResolvedModelSettings } from "../config/types.js";
import { earlierUsageRecordsOf, partialUsageRecordsOf } from "./partial-usage.js";
import type { UsageRecord } from "./usage.js";

/**
 * A model call of a component that is not the agent loop — a judge, a router, an arbiter, a guardrail,
 * a reranker, a compaction, a file reader, an interpreter — accounted for what it spent even when it
 * fails mid-way (#1399): the provider's report if it gave one, else what was counted from the chunks
 * that came, each provider that took part under its own model and price; and, when a fallback answered
 * after another provider failed, what that one billed. Where the records go is the caller's `sink`.
 */

type Settings = Pick<ResolvedModelSettings, "model" | "price" | "modelProvider" | "unpriced">;

/** What a call is made of: who it is for, its settings, what it sends, where its extra spend goes. */
export interface ChargedSpec {
  readonly caller: string;
  readonly settings: Settings;
  /** What the call sends: its text or messages (the prompt size a failed call is counted from). */
  readonly sent: unknown;
  /** Takes the records the call's own result does not carry. */
  readonly sink: (records: readonly UsageRecord[]) => void;
}

/** The records go to the current execution's frame (accounted like a tool's reported cost). */
export const reportToFrame = (records: readonly UsageRecord[]): void => {
  const report = currentFrame()?.services.reportUsage;
  records.forEach((record) => report?.(record));
};

/**
 * Where a call's extra spend goes: the current frame's report when it has one, else — outside a step
 * (an eval run, a standalone check) — into `collected`, for the caller to account on its result (#1399).
 */
export function frameOrCollected(): {
  readonly sink: ChargedSpec["sink"];
  readonly collected: UsageRecord[];
} {
  const collected: UsageRecord[] = [];
  const sink = (records: readonly UsageRecord[]): void => {
    if (currentFrame()?.services.reportUsage === undefined) collected.push(...records);
    else reportToFrame(records);
  };
  return { sink, collected };
}

const sizeOf = (sent: ChargedSpec["sent"]): number =>
  typeof sent === "string" ? sent.length : JSON.stringify(sent).length;

/**
 * `call` with a chunk counter among its callbacks. Its answer is returned as it is — the sink gets
 * what the providers that failed before the answering one billed; a failure is rethrown as it is —
 * after the sink got what it spent.
 */
export async function chargedCall<T extends { readonly response_metadata?: unknown }>(
  spec: ChargedSpec,
  call: (callbacks: Callbacks) => Promise<T>,
  callbacks?: Callbacks,
): Promise<T> {
  const counter = new ChunkCounter();
  const chars = sizeOf(spec.sent);
  try {
    // the call keeps the callbacks it would have inherited (the trace, the stream), the counter beside them
    const inherited = callbacks ?? ensureConfig().callbacks;
    const answer = await call(withChunkCounter(inherited, counter));
    const metadata: unknown = answer.response_metadata;
    const earlier = earlierUsageRecordsOf(
      spec.caller,
      spec.settings,
      typeof metadata === "object" && metadata !== null
        ? (metadata as Readonly<Record<string, unknown>>)
        : undefined,
      chars,
    );
    if (earlier.length > 0) spec.sink(earlier);
    return answer;
  } catch (error) {
    const spent = partialUsageRecordsOf(spec.caller, spec.settings, error, {
      requestChars: chars,
      answerChars: counter.chars,
    });
    if (spent.length > 0) spec.sink(spent);
    throw error;
  }
}

/** `chargedCall` for a component whose extra spend is reported to the step it runs in. */
export const reportedCall = <T extends { readonly response_metadata?: unknown }>(
  caller: string,
  settings: ChargedSpec["settings"],
  sent: unknown,
  call: (callbacks: Callbacks) => Promise<T>,
): Promise<T> => chargedCall({ caller, settings, sent, sink: reportToFrame }, call);
