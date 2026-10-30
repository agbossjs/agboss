import { errorRecordOf } from "../core/error-record.js";
import type { FrameSpec } from "../flow/context/frame.js";
import { nodeEventOf } from "../flow/observers/execution-event.js";
import type { OutboundCallEventOutcome } from "../infrastructure/execution-lease-event.repository.js";
import type { OutboundCallSettings } from "../infrastructure/fenced-effect-settings.js";
import type { FencedEffectKey } from "../infrastructure/fenced-effect.repository.js";
import type {
  OutboundCallFailure,
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
  type OutboundCallPart,
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
  readonly live: Map<string, Promise<OutboundCallOutcome<unknown>>>;
}

/** One call in flight: its parts, key, options, the step's frame and the key it goes with. */
export interface CallRun<TRequest, TResult> {
  readonly parts: OutboundCallParts;
  readonly key: FencedEffectKey;
  readonly options: OutboundCallOptions<TRequest, TResult>;
  readonly frame: FrameSpec;
  readonly idempotencyKey: string;
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
  const mask = run.frame.execution.observability;
  if (mask === undefined)
    return { name, code, message: run.parts.settings.requiresMask ? REDACTED : message };
  return { name, code, message: String(await mask.traceData(message)) };
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

/** What `reconcile` gets: the request as stored (masked) and the key to look the call up by. */
export const lookupOf = <TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  storedRequest: string,
  attempt: number,
): OutboundCallLookup => ({
  idempotencyKey: run.idempotencyKey,
  storedRequest,
  attempt,
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
  idempotencyKey: run.idempotencyKey,
});

/** Tells the lease log and `onOutboundCall` of a move of the call (#505): never its payload. */
export function told<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  outcome: OutboundCallEventOutcome,
  [status, attempt]: readonly [OutboundCallStatus, number],
): void {
  const { key, options, frame } = run;
  frame.execution.lease?.recordOutboundCall?.({
    event: nodeEventOf(frame),
    ...{ name: key.name, target: options.target, operation: options.operation },
    ...{ status, attempt, outcome, scopeKey: key.scopeKey, token: key.token },
  });
}
