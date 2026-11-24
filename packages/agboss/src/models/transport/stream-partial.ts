import type { Usd } from "../../units/index.js";
import type { TokenUsage } from "../../finops/usage.js";
import type { ModelCost } from "../cost.js";

/**
 * What a streamed call that failed mid-way had used (#1399), as its provider reported it: the stream's
 * `result` settled with it after the failure. It travels with the error the call surfaces — the
 * error itself stays the original failure — to the one place that records the spend of a call.
 */
export interface PartialSpend {
  readonly usage: TokenUsage;
  readonly cost?: Usd | undefined;
}

const partials = new WeakMap<object, PartialSpend>();

/**
 * `error` with the partial spend it carries. A thrown value that is no object (a project's `throw
 * "x"`) cannot carry it: it is wrapped, so the spend is never dropped.
 */
export function withPartialSpend(error: unknown, spend: PartialSpend): unknown {
  const carrier: object =
    typeof error === "object" && error !== null
      ? error
      : new Error(String(error), { cause: error });
  partials.set(carrier, spend);
  return carrier;
}

/** The partial spend of a failed streamed call: the error's, or that of one of its causes. */
export function partialSpendOf(error: unknown): PartialSpend | undefined {
  let cause: unknown = error;
  while (typeof cause === "object" && cause !== null) {
    const found = partials.get(cause);
    if (found !== undefined) return found;
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return undefined;
}

/** Who served a call that fell back: its provider, the model it was asked for, its price table. */
export interface FallbackServer {
  readonly provider: string;
  readonly model: string;
  readonly cost: ModelCost | undefined;
}

/**
 * What a provider that failed before another answered had spent: the usage it reported, else the
 * characters it streamed (counted). `server` is who it was — absent, the call's own provider.
 */
export interface EarlierShare {
  readonly server?: FallbackServer | undefined;
  readonly reported?: PartialSpend | undefined;
  readonly chars: number;
}

/** What a fallback chain leaves on a failed call: who was serving it, and the shares of those before. */
export interface FailoverTrace {
  readonly server: FallbackServer;
  readonly earlier: readonly EarlierShare[];
}

const traces = new WeakMap<object, FailoverTrace>();

/** `error` marked with the provider that was serving when it failed, and the earlier failed shares. */
export function withFailoverTrace(error: unknown, trace: FailoverTrace): unknown {
  const carrier: object =
    typeof error === "object" && error !== null
      ? error
      : new Error(String(error), { cause: error });
  traces.set(carrier, trace);
  return carrier;
}

/** The failover trace of a failed call: the error's, or one of its causes'. */
export function failoverTraceOf(error: unknown): FailoverTrace | undefined {
  let cause: unknown = error;
  while (typeof cause === "object" && cause !== null) {
    const found = traces.get(cause);
    if (found !== undefined) return found;
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return undefined;
}
