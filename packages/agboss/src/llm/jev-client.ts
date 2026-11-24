import { systemClock, type Clock } from "../infrastructure/clock.js";
import { timeoutError, timeoutOn } from "../infrastructure/clock.js";
import { seconds, type Milliseconds } from "../units/index.js";
import type {
  BooleanQuestion,
  DecisionQuestion,
  DecisionQuestions,
  DecisionState,
} from "./decisions.js";

/** Where the Decisions API is: OpenRouter's base URL and key. */
export interface JevConnection {
  /** Absent or empty (a self-hosted gateway without a key): no `Authorization` header. */
  readonly apiKey?: string | undefined;
  readonly baseUrl: string;
  /** The endpoint under the base URL; default `/alpha/decisions` (a trailing `/v1` of the base is dropped). */
  readonly path?: string | undefined;
  /** Headers the gateway wants besides the key. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/** A Decisions API request: `POST {base}/alpha/decisions` with `{ model, state, questions }`. */
export interface JevDecisionRequest {
  readonly model: string;
  /** What the decision is made about: a text, a JSON object, or text and image parts. */
  readonly state: DecisionState;
  readonly questions: DecisionQuestions;
}

/** Raw transport; the response is validated by the caller. */
export type JevClient = (
  request: JevDecisionRequest,
  /** The provider's `name` the model's cascade resolved (#1313); absent: the one that serves the model. */
  modelProvider?: string,
) => Promise<unknown>;

/** The Decisions API's own name of a yes/no question, and of its answer's field. */
const WIRE_BOOLEAN = "noul";

/** A question as the Decisions API takes it. */
type WireQuestion =
  | Exclude<DecisionQuestion, BooleanQuestion>
  | (Omit<BooleanQuestion, "type"> & { readonly type: typeof WIRE_BOOLEAN });

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A question as the Decisions API takes it: a `boolean` question is `noul` there. */
function toWireQuestion(question: DecisionQuestion): WireQuestion {
  return question.type === "boolean" ? { ...question, type: WIRE_BOOLEAN } : question;
}

/** The questions of a request in the Decisions API's wire shape. */
function toWireQuestions(questions: DecisionQuestions): Readonly<Record<string, WireQuestion>> {
  return Object.fromEntries(
    Object.entries(questions).map(([id, question]) => [id, toWireQuestion(question)]),
  );
}

/** A wire `{ type: "noul", noul }` answer as `{ type: "boolean", probability }`; any other as given. */
function fromWireAnswer(answer: unknown): unknown {
  if (!isRecord(answer) || answer.type !== WIRE_BOOLEAN) return answer;
  return { type: "boolean", probability: answer[WIRE_BOOLEAN] };
}

/**
 * The Decisions API's response with its yes/no answers in the public shape; the rest as given.
 * Nothing is validated here: `readDecision` checks every answer against its question.
 */
function fromWireResponse(raw: unknown): unknown {
  if (!isRecord(raw) || !isRecord(raw.answers)) return raw;
  const answers = Object.fromEntries(
    Object.entries(raw.answers).map(([id, answer]) => [id, fromWireAnswer(answer)]),
  );
  return { ...raw, answers };
}

export class JevApiError extends Error {
  override name = "JevApiError";
  /** The HTTP status; `isFailoverError` sorts the provider's faults from the request's refusals by it. */
  readonly status?: number;
  /** The `error` object of the provider's JSON body, when it has one (its `code`, `type`). */
  readonly error?: unknown;

  constructor(message: string, response?: { readonly status: number; readonly body: string }) {
    super(message);
    if (response === undefined) return;
    this.status = response.status;
    this.error = errorOf(response.body);
  }
}

/** The `error` of a provider's JSON error body; `undefined` for any other body. */
function errorOf(body: string): unknown {
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

export function jevDecisionsUrl(baseUrl: string, path = "/alpha/decisions"): string {
  return `${baseUrl.replace(/\/v1\/?$/, "")}${path}`;
}

/** A decision that gets no answer in time fails (a router falls back as usual). */
export const JEV_TIMEOUT: Milliseconds = seconds(30);

/**
 * OpenRouter Decisions API (alpha): POST {base}/alpha/decisions, for every decision model. The
 * whole call is bounded by `timeout` on `clock` (the provider's fetch also has its own timeout).
 * The wire adapter: a `boolean` question goes out as the API's `noul`, and its answer comes back
 * as `{ type: "boolean", probability }`.
 */
export function createJevClient(
  connection: JevConnection,
  fetchImpl: typeof fetch = fetch,
  timeout: Milliseconds = JEV_TIMEOUT,
  clock: Clock = systemClock,
): JevClient {
  const url = jevDecisionsUrl(connection.baseUrl, connection.path);
  const key = connection.apiKey;
  return async (request) => {
    const timer = timeoutOn(clock, timeout, timeoutError);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          ...connection.headers,
          ...(key === undefined || key === "" ? {} : { Authorization: `Bearer ${key}` }),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...request, questions: toWireQuestions(request.questions) }),
        signal: timer.signal,
      });
      if (!response.ok) {
        const body = await response.text();
        throw new JevApiError(`Decisions API ${String(response.status)}: ${body}`, {
          status: response.status,
          body,
        });
      }
      const body: unknown = await response.json();
      return fromWireResponse(body);
    } finally {
      timer.release();
    }
  };
}
