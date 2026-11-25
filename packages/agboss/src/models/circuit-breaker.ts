import type { Milliseconds } from "../units/index.js";
import { AGBossError } from "../core/errors.js";
import type { ModelInputKind } from "./content.js";
import type { Clock } from "../infrastructure/clock.js";
import type { RateLimitRepository } from "../infrastructure/rate-limit.repository.js";
import {
  longestOpenOf,
  openDurationOf,
  probesOf,
  shortestOpenOf,
  type CircuitBreakerPolicy,
} from "./circuit-breaker-policy.js";

/** Codes of a failed model call the framework raises itself. */
export type ModelCallErrorCode =
  "model.circuit-open" | "model.unsupported-input" | "model.cli-failed";

/** What a model call the framework failed itself takes (#906): why, the provider and the message. */
export interface ModelCallErrorOptions {
  /** Why: `model.circuit-open`; `model.unsupported-input` (#899: a part the model cannot take); `model.cli-failed` (#1313: a CLI that cannot start, or whose first frame refuses the call). */
  readonly code: ModelCallErrorCode;
  /** The provider's name. */
  readonly provider: string;
  readonly message: string;
  /** The model asked (`model.unsupported-input`). */
  readonly model?: string;
  /** The kind and the media type of the part it cannot take (`model.unsupported-input`). */
  readonly kind?: ModelInputKind;
  readonly mediaType?: string;
  readonly cause?: unknown;
}

/** A model call the framework failed itself; `code` on the instance says why (`model.circuit-open`). */
export class ModelCallError extends AGBossError {
  static override readonly code = "model" as const;
  override name = "ModelCallError";
  override readonly code: ModelCallErrorCode;
  /** The provider's name. */
  readonly provider: string;
  /** The model asked, when `code` is `model.unsupported-input`. */
  readonly model: string | undefined;
  /** The kind of input it cannot take, when `code` is `model.unsupported-input`. */
  readonly kind: ModelInputKind | undefined;
  readonly mediaType: string | undefined;

  constructor(options: ModelCallErrorOptions) {
    const { code, provider, message, model, kind, mediaType, cause } = options;
    super(`${code}: ${message}`, { cause });
    this.code = code;
    this.provider = provider;
    this.model = model;
    this.kind = kind;
    this.mediaType = mediaType;
  }
}

/** Where a breaker keeps its state and reads the time: the application's (#265 S52, #262 S75 d). */
export interface CircuitBreakerStore {
  readonly rateLimits: RateLimitRepository;
  readonly clock: Clock;
  /** Told of each state change this breaker made (`onCircuitStateChange`); a throw is no failure of the call. */
  readonly onTransition?: (transition: CircuitTransition) => void;
}

/** Where a provider's open breaker is kept in `RateLimitRepository`: a pause under this key. */
export const circuitOpenKeyOf = (provider: string): string => `${provider}:circuit-open`;

/** Where a breaker is: calls flow, are refused, or are let through a few at a time to try the provider. */
export type CircuitState = "closed" | "open" | "half-open";

/** A call's way in: free, as one of the probes of a half-open breaker, or refused. */
export type CircuitAdmission = "closed" | "probe" | "refused";

/** A state change one told outcome made (what `onCircuitStateChange` reports). */
export interface CircuitTransition {
  readonly from: CircuitState;
  readonly to: CircuitState;
}

/**
 * One provider's breaker: counts failed calls in a sliding window and opens; after the open it is
 * half-open — `halfOpenProbes` calls at a time go through, a success closes it, a failure opens it
 * again, longer with `exponential`. All of its state — the failures, the open pause, the opens in
 * a row, the probe slots — is in the application's `RateLimitRepository` as windows and pauses
 * (atomic there), so it holds on every instance at once; its time is the application's `Clock`.
 */
export class CircuitBreaker {
  readonly #failures: string;
  readonly #open: string;
  readonly #streak: string;
  readonly #probes: string;

  constructor(
    provider: string,
    private readonly policy: CircuitBreakerPolicy,
    private readonly store: CircuitBreakerStore,
    private readonly random: () => number = Math.random,
  ) {
    this.#failures = `${provider}:circuit-failures`;
    this.#open = circuitOpenKeyOf(provider);
    this.#streak = `${provider}:circuit-streak`;
    this.#probes = `${provider}:circuit-probes`;
  }

  /** The opens in a row are remembered twice the longest open: past it the provider is trusted again. */
  get #streakWindow(): Milliseconds {
    return (longestOpenOf(this.policy) * 2) as Milliseconds;
  }

  async #opensInARow(): Promise<number> {
    return (await this.store.rateLimits.addToWindow(this.#streak, 0, this.#streakWindow)) ?? 0;
  }

  /** Where the breaker is now: open while the pause lasts, half-open after it until a success. */
  async state(): Promise<CircuitState> {
    if ((await this.store.rateLimits.pausedUntil(this.#open)) !== undefined) return "open";
    return (await this.#opensInARow()) > 0 ? "half-open" : "closed";
  }

  /** Open: calls must not reach the provider. Closes by itself once the open has passed. */
  async isOpen(): Promise<boolean> {
    return (await this.store.rateLimits.pausedUntil(this.#open)) !== undefined;
  }

  /**
   * The way in for a call: free while closed; refused while open; half-open takes one of the
   * `halfOpenProbes` slots (all taken → refused). A slot not reported back frees itself.
   */
  async admit(): Promise<CircuitAdmission> {
    const { rateLimits } = this.store;
    if ((await rateLimits.pausedUntil(this.#open)) !== undefined) return "refused";
    if ((await this.#opensInARow()) === 0) return "closed";
    const slot = await rateLimits.addToWindow(
      this.#probes,
      1,
      shortestOpenOf(this.policy),
      probesOf(this.policy),
    );
    return slot === undefined ? "refused" : "probe";
  }

  /** A change of state, told to the store's listener — which never fails the call that made it. */
  #told(transition: CircuitTransition): CircuitTransition {
    try {
      this.store.onTransition?.(transition);
    } catch {
      // a listener that throws is its own: the breaker's state is already written
    }
    return transition;
  }

  /** Opens it: the open number in a row, its length by the policy; the count of failures starts anew. */
  async #trip(): Promise<void> {
    const { rateLimits, clock } = this.store;
    const streak = (await rateLimits.addToWindow(this.#streak, 1, this.#streakWindow)) ?? 1;
    const length = openDurationOf(this.policy, streak, this.random);
    await rateLimits.pauseUntil(this.#open, new Date(clock.now().getTime() + length));
    await rateLimits.clearWindow(this.#failures);
    await rateLimits.clearWindow(this.#probes);
  }

  /**
   * One failed call. Half-open, it opens the breaker again at once; closed, the threshold within
   * the window opens it. A failure told while it is already open (a call that began before) changes nothing.
   */
  async recordFailure(): Promise<CircuitTransition | undefined> {
    const { rateLimits } = this.store;
    const failures = await rateLimits.addToWindow(this.#failures, 1, this.policy.failureWindow);
    const isHalfOpen = (await this.#opensInARow()) > 0;
    if ((failures ?? 0) < this.policy.failureThreshold && !isHalfOpen) return undefined;
    if ((await rateLimits.pausedUntil(this.#open)) !== undefined) return undefined;
    await this.#trip();
    return this.#told({ from: isHalfOpen ? "half-open" : "closed", to: "open" });
  }

  /** A call that succeeded: the failures counted so far are forgotten; half-open, the breaker closes. */
  async recordSuccess(): Promise<CircuitTransition | undefined> {
    const { rateLimits } = this.store;
    await rateLimits.clearWindow(this.#failures);
    if ((await this.#opensInARow()) === 0) return undefined;
    if ((await rateLimits.pausedUntil(this.#open)) !== undefined) return undefined;
    await rateLimits.clearWindow(this.#streak);
    await rateLimits.clearWindow(this.#probes);
    return this.#told({ from: "half-open", to: "closed" });
  }
}
