import { markBusinessKeyWriter } from "../components/container/fenced-reach.js";
import { Injectable } from "../components/decorators.js";
import { ConfigError } from "../core/error-families/config-errors.js";
import { ttlProblemOf } from "../storage/ttl-problem.js";
import { liveExecutionContextOf } from "../flow/context/live-context.js";
import {
  FencedEffectRepository,
  type IdempotencyRunOutcome,
} from "../infrastructure/fenced-effect.repository.js";
import { OutboundMasking } from "./outbound-masking.js";
import { Clock, lazyLoad } from "../infrastructure/clock.js";
import { frameworkLogOf, Logger } from "../infrastructure/logger.js";
import { OutboundCallRepository } from "../infrastructure/outbound-call.repository.js";
import { kilobytes, seconds, Ttl, type Bytes, type Milliseconds } from "../units/index.js";
import { MAX_TIMEOUT, timerProblemOf } from "../units/timer-limits.js";
import { EXECUTION_LEASE } from "./lease-fence.js";
import type { IdempotencyRunOptions } from "./idempotency-types.js";
import { boundedWork } from "./idempotency-work.js";
import { callKeyIn } from "./idempotency-keys.js";
import { assertNotNested, assertOutsideRunOnce, inRunOnce } from "./idempotency-scope.js";
import { callKeyErrorOf, checkedRecovery } from "./outbound-call-contract.js";
import { expiryOf, type LiveCall } from "./outbound-call-parts.js";
import type {
  IdempotencySendOptions,
  OutboundCallOutcome,
  OutboundCallRun,
} from "./outbound-call-types.js";

export { OutboundCallSendStatus } from "./outbound-call-types.js";
export type {
  OutboundCall,
  OutboundCallLookup,
  IdempotencySendOptions,
  OutboundCallOutcome,
  OutboundCallUnreconciledReason,
  OutboundCallResultNotStoredReason,
} from "./outbound-call-types.js";
export type { IdempotencyKeyChoice, IdempotencyRunOptions } from "./idempotency-types.js";
export type { OutboundCallPart } from "./outbound-call-errors.js";

/** The default bound of `runOnce`'s `execute`: below the lease's 30 s. */
const DEFAULT_RUN_TIMEOUT: Milliseconds = seconds(15);

/** The default largest request or result of a call: 64 KB. */
const DEFAULT_PAYLOAD_SIZE: Bytes = kilobytes(64);

/** A refusal of the call's own options, before anything is recorded or run. */
const refused = (method: string, problem: string): ConfigError.Option =>
  new ConfigError.Option({
    message: `Idempotency.${method}: ${problem} — nothing was recorded, run or sent`,
  });

/** Why a `timeout` is not one (a positive duration, at most a day), or `undefined`. */
function timeoutProblemOf(timeout: unknown): string | undefined {
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)
    return `timeout is ${String(timeout)}, not a positive duration`;
  return timerProblemOf("timeout", timeout, MAX_TIMEOUT);
}

/**
 * The application's idempotent effects (#500, #505, #1317): a core service a component injects
 * (`deps: [Idempotency]`) — `runOnce` for a write of the application's own database, once per key, in the store's transaction
 * with its result; `sendOnce` for a call that leaves the system, its intent recorded before it is
 * sent and an unknown outcome recovered, never sent again blindly. The execution is read from the
 * step the call is made in, so a component threads nothing through. Wiki → Several-instances.
 */
@Injectable({
  deps: [FencedEffectRepository, OutboundCallRepository, OutboundMasking, Logger, Clock],
})
export class Idempotency {
  /** The calls this instance is making now, by key: a second send of one meanwhile joins it. */
  readonly #live = new Map<string, LiveCall>();
  /** The attempt owners it is sending under now. */
  readonly #owners = new Set<string>();

  /**
   * @internal The container injects the application's stores, settings, log and clock: left out of
   * the declarations.
   */
  constructor(
    private readonly effects: FencedEffectRepository<unknown>,
    private readonly calls: OutboundCallRepository,
    private readonly masking: OutboundMasking,
    // the instance's log (#508), names and ids only — said by whoever builds it (#825)
    private readonly logger: Logger,
    // the application's clock (#825): a call's attempt and its key's age, never the wall clock by default
    private readonly clock: Clock,
  ) {
    // #825: said by whoever builds it — a JavaScript caller's missing logger or clock is refused
    const given: readonly unknown[] = [logger, clock];
    if (given.some((part) => typeof part !== "object" || part === null))
      throw new TypeError("new Idempotency(…): a Logger and a Clock are required");
  }

  /**
   * Runs `execute` once per key (`name`, and `key` when named), in the store's transaction with its
   * result: stored before → its result (`Replayed`, `execute` not called); run by this instance now
   * → its outcome (`Joined`); else `execute` runs and its result is kept (`Ran`). A zombie's call —
   * its lease taken over — is refused (`ExecutionError.Fenced`), nothing written. Rejects, never
   * throws, on a bad option.
   */
  async runOnce<TResult, TFingerprint = never, TTransaction = unknown>(
    options: IdempotencyRunOptions<TResult, TFingerprint, TTransaction>,
  ): Promise<IdempotencyRunOutcome<TResult>> {
    // read once: a getter is never asked again
    const { name, key, ttl, maxResultSize, execute } = options;
    const timeout = options.timeout ?? DEFAULT_RUN_TIMEOUT;
    const ttlProblem = ttl === Ttl.Forever ? undefined : ttlProblemOf(ttl, true);
    if (ttlProblem !== undefined) throw refused("runOnce", `ttl ${ttlProblem}`);
    const timeoutProblem = timeoutProblemOf(timeout);
    if (timeoutProblem !== undefined) throw refused("runOnce", timeoutProblem);
    if (timeout >= EXECUTION_LEASE) throw refused("runOnce", `timeout is not below the lease`);
    if (typeof execute !== "function") throw refused("runOnce", "execute is not a function");
    assertNotNested(name);
    const context = liveExecutionContextOf(undefined, "Idempotency");
    const expiresAt = expiryOf(this.clock, ttl);
    const parts = { ...options, key, expiresAt, maxResultSize };
    const effectKey = callKeyIn(context, name, parts, "runOnce");
    const bounded = boundedWork(this.clock, { name, timeout }, execute);
    // `execute` runs in the scope of its runOnce, closed once it ended (a store may call it again)
    const scoped: typeof bounded = (transaction) => inRunOnce(name, () => bounded(transaction));
    return this.effects.runOnce(effectKey, scoped);
  }

  /**
   * Sends the call of `name` (and `key`) at most once per outcome: completed → its stored result
   * (`Replayed`); left pending — a crash before the answer, an error of unknown outcome (#657) —
   * → the `recovery` decides, a resend refused past its window (#658); failed for certain
   * (`isDefiniteFailure`) → sent again with the same key; none → recorded, then sent; answered
   * after a newer attempt took it over → `OutboundCallError.Superseded` (#795). A zombie's call,
   * or one whose options or `recovery` are not valid, is refused before anything is recorded or sent.
   */
  async sendOnce<TRequest, TResult>(
    options: IdempotencySendOptions<TRequest, TResult>,
  ): Promise<OutboundCallOutcome<TResult>> {
    // read once: a getter is never asked again
    const { name, key, target, request, timeout, ttl, send, recovery, isDefiniteFailure } = options;
    assertOutsideRunOnce(`Idempotency.sendOnce "${name}"`);
    const operation = options.operation ?? name;
    const maxPayloadSize = options.maxPayloadSize ?? DEFAULT_PAYLOAD_SIZE;
    const timeoutProblem = timeoutProblemOf(timeout);
    if (timeoutProblem !== undefined) throw refused("sendOnce", timeoutProblem);
    const ttlProblem = ttl === Ttl.Forever ? undefined : ttlProblemOf(ttl, true);
    if (ttlProblem !== undefined) throw refused("sendOnce", `ttl ${ttlProblem}`);
    if (typeof send !== "function") throw refused("sendOnce", "send is not a function");
    if (typeof target !== "string" || target.length === 0)
      throw refused("sendOnce", "target is not a name");
    const checked = checkedRecovery(name, recovery, { timeout, ttl });
    const context = liveExecutionContextOf(undefined, "Idempotency");
    // the scope's mark lives as long as the longest ttl written under it (`null`: for good)
    const expiresAt = expiryOf(this.clock, ttl);
    const stepKey = callKeyIn(context, name, { key, expiresAt }, "sendOnce");
    // the checked copy is the one the protocol reads (`options` as given is the caller's, live)
    callKeyErrorOf(stepKey);
    const run: OutboundCallRun<TRequest, TResult> = {
      name,
      target,
      operation,
      request,
      timeout,
      ttl,
      maxPayloadSize,
      send,
      isDefiniteFailure,
      reconcile: checked.reconcile,
      notSent: checked.notSent,
    };
    const { sendOutboundCall } = await lazyLoad(import("./outbound-call-protocol.js"));
    const parts = {
      repository: this.calls,
      requiresMask: this.masking.requiresMask,
      live: this.#live,
      owners: this.#owners,
      log: frameworkLogOf(this.logger, this.clock),
      clock: this.clock,
    };
    return sendOutboundCall(parts, stepKey, run);
  }
}

// #825: a component that reaches Idempotency can write under a business key
markBusinessKeyWriter(Idempotency);

/**
 * What a component gets for `Idempotency` outside an application's container: `agboss check`
 * builds a workflow's components and never runs them, and a workflow on its own has no
 * infrastructure — every call is refused, since an effect's store is the application's.
 */
export const IDEMPOTENCY_OUTSIDE_APPLICATION = Object.freeze({
  runOnce: async (): Promise<never> =>
    Promise.reject(
      new TypeError(
        "Idempotency.runOnce: an idempotent effect runs in an application (createApp, testWith, a unit runner) — its store is the application's infrastructure",
      ),
    ),
  sendOnce: async (): Promise<never> =>
    Promise.reject(
      new TypeError(
        "Idempotency.sendOnce: a call that leaves the system runs in an application (createApp, testWith, a unit runner) — its store is the application's infrastructure",
      ),
    ),
});
