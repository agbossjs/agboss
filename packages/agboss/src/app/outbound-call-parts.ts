import { errorRecordOf } from "../core/error-record.js";
import { reportedKeyOf } from "./outbound-call-business.js";
import type { FrameSpec } from "../flow/context/frame.js";
import { nodeEventOf } from "../flow/observers/execution-event.js";
import type {
  OutboundCallEventOutcome,
  OutboundCallSupersededLease,
} from "../infrastructure/execution-lease-event.repository.js";
import type { OutboundCallSettings } from "../infrastructure/fenced-effect-settings.js";
import type { Clock } from "../infrastructure/clock.js";
import type { FrameworkLog, LogSubject } from "../infrastructure/logger.js";
import type {
  FencedEffectKey,
  FencedEffectOrigin,
} from "../infrastructure/fenced-effect.repository.js";
import type {
  OutboundCallFailure,
  OutboundCallRecord,
  OutboundCallRepository,
  OutboundCallStatus,
} from "../infrastructure/outbound-call.repository.js";
import {
  OutboundCallPayloadTooLargeError,
  OutboundCallUnmaskedError,
  REDACTED,
  type OutboundCall,
  type OutboundCallLookup,
  type OutboundCallOptions,
  type OutboundCallOutcome,
  type OutboundCallOutcomeStatus,
  OutboundCallPart,
} from "./outbound-calls.js";

/**
 * The parts of the outbound-call protocol (#505), loaded with it: one call in flight and what it
 * stores. Everything an intent stores — its request, its result, its failure's text — is masked
 * **when it is written**, by the calling frame's mask (the application's and that workflow's PII
 * policies), so every read surface shows what is stored as it is; `send` and the step get the real
 * values in memory only. No mask where policies exist fails closed: nothing stored raw.
 */

/** What the protocol runs on: the store and the application's settings. */
export interface OutboundCallParts {
  readonly repository: OutboundCallRepository;
  readonly settings: OutboundCallSettings;
  /** The calls the instance is making now, by key (`OutboundCalls`' own): what a second one joins. */
  readonly live: Map<string, LiveCall>;
  /** The attempt owners this instance is sending under now (#508): their attempts are in flight. */
  readonly owners: Set<string>;
  /** The instance's log (#508): two attempts that reached the other system, a late answer. */
  readonly log: FrameworkLog;
  /** The application's clock (#658): its monotonic time ages a key between the read and the resend. */
  readonly clock: Pick<Clock, "monotonicNow">;
}

/** How a call this instance makes ended (#508): `isAnswered` once the other system answered it. */
export interface CallAnswer {
  isAnswered: boolean;
}

/**
 * A call this instance is making now: what it does (#508: its fingerprint), its outcome and whether
 * its error, if any, is the other system's answer — whatever was thrown, an object or not.
 */
export interface LiveCall {
  readonly fingerprint: string | undefined;
  readonly outcome: Promise<OutboundCallOutcome<unknown>>;
  readonly answer: CallAnswer;
}

/** One call in flight: its parts, key, options, the step's frame and the key it goes with. */
export interface CallRun<TRequest, TResult> {
  readonly parts: OutboundCallParts;
  readonly key: FencedEffectKey;
  readonly options: OutboundCallOptions<TRequest, TResult>;
  readonly frame: FrameSpec;
  readonly idempotencyKey: string;
  /** Whether the other system answered its attempt with an error: what a joined call shares. */
  readonly answer: CallAnswer;
}

/**
 * `value` as the store keeps it: masked by the frame's mask, as JSON, within the limit — else
 * `OutboundCallPayloadTooLargeError`; no mask while the application lists policies →
 * `OutboundCallUnmaskedError` (never stored raw).
 */
export async function storedJson<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  part: OutboundCallPart,
  value: unknown,
): Promise<string> {
  const mask = run.frame.execution.observability;
  if (mask === undefined && run.parts.settings.requiresMask)
    throw new OutboundCallUnmaskedError(run.key.name);
  const text = JSON.stringify(mask === undefined ? value : await mask.value(value));
  const size = Buffer.byteLength(text, "utf8");
  const { maxPayloadSize } = run.parts.settings;
  if (size > maxPayloadSize)
    throw new OutboundCallPayloadTooLargeError({ call: run.key.name, part, size, maxPayloadSize });
  return text;
}

/**
 * The error a failed call is recorded with: its name, code and text, never a payload — the text
 * (free, it may name a person) masked like the request; no mask where policies exist → redacted.
 */
export async function maskedFailureOf<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  error: unknown,
): Promise<OutboundCallFailure> {
  const { name, code, message } = errorRecordOf(error);
  return { name, code, message: await maskedTextOf(run, message) };
}

/**
 * `text` as the frame's mask shows it — a failure's message, `reconcile`'s reason — `[redacted]`
 * where the application lists policies and the frame has no mask, or where masking failed (#508):
 * never stored or thrown as it is.
 */
export async function maskedTextOf<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  text: string,
): Promise<string> {
  const mask = run.frame.execution.observability;
  const redacted = (): string => {
    const why = `a text of outbound call "${run.key.name}" (${run.options.operation} on ${run.options.target}) is stored ${REDACTED}: no mask could be applied to it`;
    run.parts.log.warn("outbound-call.text-redacted", why, subjectOf(run));
    return REDACTED;
  };
  if (mask === undefined) return run.parts.settings.requiresMask ? redacted() : text;
  return mask.traceData(text).then(String, redacted);
}

/** What a log entry of `run` is about: its execution and tenant. */
export const subjectOf = <TRequest, TResult>(run: CallRun<TRequest, TResult>): LogSubject => ({
  executionId: run.frame.execution.executionId,
  tenantId: run.key.tenantId,
});

/** The key of what a completed attempt stores in place of a result it could not store (#508). */
export const RESULT_NOT_STORED = "agboss:result-not-stored";

/** The code a stored result's marker names, when `stored` is one (#508). */
export function notStoredOf(stored: unknown): string | undefined {
  if (typeof stored !== "object" || stored === null || !(RESULT_NOT_STORED in stored))
    return undefined;
  return String((stored as Record<string, unknown>)[RESULT_NOT_STORED]);
}

/**
 * What a completed attempt stores of `result` (#508): the masked JSON — or, when it cannot be stored
 * (above the limit, refused by the mask), a marker saying so: the call happened, so the attempt
 * ends `Completed` either way, never `Failed` (which would send it again).
 */
export async function storedResultOf<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  result: unknown,
): Promise<string> {
  try {
    return await storedJson(run, OutboundCallPart.Result, result);
  } catch (error) {
    const { code } = errorRecordOf(error);
    const why = `the result of outbound call "${run.key.name}" (${run.options.operation} on ${run.options.target}) was not stored (${code}): its intent is completed without it — a replay fails with OutboundCallResultNotStoredError`;
    run.parts.log.warn("outbound-call.result-not-stored", why, subjectOf(run));
    return JSON.stringify({ [RESULT_NOT_STORED]: code });
  }
}

/** What `send` gets: the real request, in memory only. */
export const callOf = <TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  attempt: number,
): OutboundCall<TRequest> => ({
  idempotencyKey: run.idempotencyKey,
  request: run.options.request,
  attempt,
  target: run.options.target,
  operation: run.options.operation,
  signal: run.frame.execution.signal,
});

/**
 * What `reconcile` gets: the request as stored (masked), the key to look the call up by, when its
 * pending attempt started and how old its key is (#658).
 */
export const lookupOf = <TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  found: OutboundCallRecord,
  ages: Pick<OutboundCallLookup, "attemptStartedAt" | "keyAge">,
): OutboundCallLookup => ({
  idempotencyKey: run.idempotencyKey,
  storedRequest: found.request,
  attempt: found.attempt,
  ...ages,
  target: run.options.target,
  operation: run.options.operation,
  signal: run.frame.execution.signal,
});

/** An outcome of the call: `result` a copy the step owns (JSON in, JSON out). */
export const outcomeOf = <TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  status: OutboundCallOutcomeStatus,
  result: unknown,
  attempt: number,
): OutboundCallOutcome<TResult> => ({
  status,
  // the JSON of a result of this call: what `send` or `reconcile` answered, or what was stored
  result: JSON.parse(JSON.stringify(result)) as TResult,
  attempt,
  // a business key never in what the step may hand a model (#508): its handle only
  idempotencyKey: reportedKeyOf(run.key, run.idempotencyKey),
});

/** What a move tells besides its state (#508): who made a replay, the newer attempt, a closed lease. */
export interface OutboundCallMoveFacts {
  readonly replayedFrom?: FencedEffectOrigin | undefined;
  readonly supersededBy?: number | undefined;
  readonly supersededLease?: OutboundCallSupersededLease | undefined;
}

/** Tells the lease log and `onOutboundCall` of a move of the call (#505): never its payload. */
export function told<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  outcome: OutboundCallEventOutcome,
  [status, attempt]: readonly [OutboundCallStatus, number],
  extras: OutboundCallMoveFacts = {},
): void {
  const { key, options, frame } = run;
  const facts = Object.fromEntries(
    Object.entries(extras).filter(([, value]) => value !== undefined),
  );
  frame.execution.lease?.recordOutboundCall?.({
    event: nodeEventOf(frame),
    ...{ name: key.name, target: options.target, operation: options.operation },
    ...{ status, attempt, outcome, scopeKey: key.scopeKey, token: key.token },
    ...facts,
  });
}
