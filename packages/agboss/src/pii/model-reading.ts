import { AsyncLocalStorage } from "node:async_hooks";
import type { UsageRecord } from "../finops/usage.js";
import type { PiiPolicySet } from "./policy-set.js";
import { DetectionMode } from "./runtime-policy.js";
import type { PiiTokenMap } from "./tokens.js";

/**
 * A model the framework calls on behalf of an agent (#708: the LLM reranker of its knowledge base)
 * reads what it reads as the agent's own model would: through the agent's PII policies, with its
 * execution's sensitive values and key. A block rule in a text refuses it (`PiiRefusedError`) — what
 * the agent's boundary does with the same text — so the value never reaches that model. Its answer
 * needs no reveal when it names no value (a ranking by numbers).
 */

/**
 * The texts as the model reads them, the tokens they hold (to reveal an answer that names one) and
 * what masking them cost (a model detector's calls).
 */
export interface MaskedReading {
  readonly texts: readonly string[];
  readonly tokens: PiiTokenMap;
  readonly usage: readonly UsageRecord[];
}

/** Masks texts for a model read on behalf of an agent; throws `PiiRefusedError` on a block rule. */
export type ModelReadingMask = (texts: readonly string[]) => Promise<MaskedReading>;

/** The reading through `set` (`known`: the execution's tokens so far); none without policies. */
export function modelReadingMaskOf(
  set: PiiPolicySet | undefined,
  known: PiiTokenMap = {},
): ModelReadingMask | undefined {
  if (set === undefined || set.isEmpty) return undefined;
  return async (texts) => {
    const usage: UsageRecord[] = [];
    const masked: string[] = [];
    let tokens: PiiTokenMap = known;
    for (const text of texts) {
      const one = await set.mask(text, tokens, DetectionMode.WithModel);
      usage.push(...one.usage);
      tokens = { ...tokens, ...one.masked.tokens };
      const refused = await set.refusalError(one.masked.blocked, usage);
      if (refused !== undefined) throw refused;
      masked.push(one.masked.text);
    }
    return { texts: masked, tokens, usage };
  };
}

/**
 * The reading of the agent whose step runs now (#708): set around the work that may call such a
 * model on its behalf — its context-mode retrievals, its tool calls — and read where the call is
 * made (the reranking, loaded lazily), so no signature of a public contract carries it.
 */
const currentReading = new AsyncLocalStorage<ModelReadingMask | undefined>();

/** Runs `work` with `mask` as the current reading. */
export const withModelReading = <TResult>(
  mask: ModelReadingMask | undefined,
  work: () => Promise<TResult>,
): Promise<TResult> => currentReading.run(mask, work);

/** The reading of the agent whose work runs now; none outside one (a unit runner, a contract). */
export const modelReadingNow = (): ModelReadingMask | undefined => currentReading.getStore();
