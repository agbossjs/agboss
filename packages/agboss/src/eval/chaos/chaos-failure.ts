/**
 * Chaos for `agboss eval run --chaos <rate> --chaos-seed <n>` (#396 PR 6, S2 Q11): failures injected
 * into the model calls of a live run — at the provider's HTTP client and a transport's `complete()`,
 * under the retry policy, the rate limit and the breaker — so a suite shows how the application
 * holds up: its `retryPolicy` retrying, its `.onError` side paths and its undos (#340) running. A set
 * of its own, never a `ModelFailure`: what is injected, not what a provider said. The rate and the
 * seed come together — the same seed injects the same failures into the same sequence of calls —
 * and the injected run spends from the application's real budgets.
 */

/** What chaos injects into a model call. */
export enum ChaosFailure {
  /** A 429 Too Many Requests (a transport: `ModelFailure.RateLimited`). */
  RateLimited = "rate-limited",
  /** The call times out (a transport: `ModelFailure.Timeout`). */
  Timeout = "timeout",
  /**
   * The answer comes back cut at its token limit: `finish_reason: "length"`, its text and its tool
   * calls' arguments cut short — what the agent loop's invalid answers and tool arguments meet.
   */
  TruncatedResponse = "truncated-response",
}

/** How much chaos, reproducibly: every model call fails with probability `rate`. */
export interface ChaosOptions {
  /** The share of model calls that fail: above 0, at most 1. */
  readonly rate: number;
  /** The seed of the sequence: one seed, one run's failures. */
  readonly seed: number;
  /** What is injected; each injected call picks one of them. */
  readonly failures: readonly ChaosFailure[];
}

/** Why `options` cannot inject; undefined when they can. */
export function chaosProblemOf(options: ChaosOptions): string | undefined {
  if (!(options.rate > 0 && options.rate <= 1))
    return `chaos rate: above 0 and at most 1, got ${String(options.rate)}`;
  if (!Number.isSafeInteger(options.seed))
    return `chaos seed: a whole number, got ${String(options.seed)}`;
  if (options.failures.length === 0) return "chaos failures: at least one";
  const known = new Set<string>(Object.values(ChaosFailure));
  const unknown = options.failures.filter((failure) => !known.has(failure));
  if (unknown.length > 0)
    return `chaos failures: ${unknown.join(", ")} — known: ${[...known].join(", ")}`;
  return undefined;
}

/** What chaos did in a run (`EvalRunReport.chaos`): its settings, the calls it saw, what it injected. */
export interface EvalRunChaos {
  /** The share of model calls that failed on purpose (`--chaos`). */
  readonly rate: number;
  /** The seed of the sequence (`--chaos-seed`). */
  readonly seed: number;
  /** What could be injected (`--chaos-failures`). */
  readonly failures: readonly ChaosFailure[];
  /** Model calls seen — every attempt, a retry too. */
  readonly calls: number;
  /** Failures injected, by kind (a truncation is counted only when an answer could be cut). */
  readonly injected: Readonly<Record<ChaosFailure, number>>;
}
