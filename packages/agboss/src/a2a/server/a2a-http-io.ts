import type { IncomingMessage, ServerResponse } from "node:http";
import { formatSSEErrorEvent, formatSSEEvent, SSE_HEADERS } from "@a2a-js/sdk";
import { A2AError } from "@a2a-js/sdk/errors";
import { JsonRpcTransportHandler } from "@a2a-js/sdk/server";
import type { FrameworkLog } from "../../infrastructure/logger.js";
import type { Bytes } from "../../units/index.js";
import { writeRejection } from "../a2a-caller-gate.js";
import type { ServedAgentCard } from "./a2a-card.js";
import { A2AInternalError } from "./a2a-wire-errors.js";

/**
 * The binding's reads and writes on `node:http` (#808): a body read up to its limit, one JSON
 * answer, server-sent events, the card with its entity tag.
 */

const HTTP_OK = 200;
const HTTP_NOT_MODIFIED = 304;
const HTTP_PAYLOAD_TOO_LARGE = 413;

/** Headers an answer carries besides its own (the activated extensions). */
export type AnswerHeaders = Readonly<Record<string, string>>;

export function sendJson(res: ServerResponse, body: unknown, headers: AnswerHeaders = {}): void {
  res
    .writeHead(HTTP_OK, { "content-type": "application/json", ...headers })
    .end(JSON.stringify(body));
}

/** Where the binding says what it could not answer as it should: by an error's class only. */
export type BindingLog = Pick<FrameworkLog, "error">;

const nameOf = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

/**
 * A JSON-RPC error answer of `error`, by the SDK's mapping — an A2A error as it is (fixed texts);
 * anything else (a serialization in the SDK, a broken stream) logged by its class and answered
 * `-32603` "the request failed", never with its own text.
 */
export function errorAnswerOf(id: unknown, error: unknown, log: BindingLog): unknown {
  if (!(error instanceof A2AError))
    log.error("a2a.answer-failed", `an A2A answer failed: ${nameOf(error)}`);
  const sent = error instanceof A2AError ? error : new A2AInternalError();
  return { jsonrpc: "2.0", id: id ?? null, error: JsonRpcTransportHandler.mapToJSONRPCError(sent) };
}

const FIXED_INTERNAL_TEXT = new A2AInternalError().message;

/**
 * The transport's answer, its internal error's text made the fixed one: the SDK's own mapping sends
 * an error's message for what it threw itself (its serialization of a result).
 */
export function wireSafeAnswer(answer: unknown, log: BindingLog): unknown {
  const error: unknown =
    typeof answer === "object" && answer !== null ? Reflect.get(answer, "error") : undefined;
  if (typeof error !== "object" || error === null) return answer;
  const code: unknown = Reflect.get(error, "code");
  const message: unknown = Reflect.get(error, "message");
  if (code !== INTERNAL_ERROR || message === FIXED_INTERNAL_TEXT) return answer;
  log.error("a2a.answer-failed", "an A2A answer failed in the transport");
  return { ...(answer as object), error: { code: INTERNAL_ERROR, message: FIXED_INTERNAL_TEXT } };
}

/** JSON-RPC's internal error. */
const INTERNAL_ERROR = -32603;

/** The body, or `undefined` once it is over `max` (then answered `413`, the rest discarded). */
export function bodyWithin(
  req: IncomingMessage,
  res: ServerResponse,
  max: Bytes,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size <= max) {
        chunks.push(chunk);
        return;
      }
      req.off("data", onData);
      req.resume(); // the rest discarded
      const error = "the request body is too large";
      writeRejection(res, HTTP_PAYLOAD_TOO_LARGE, { code: "a2a.body-too-large", error });
      resolve(undefined);
    };
    req.on("data", onData);
    req.once("end", () => {
      if (size <= max) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    // the caller hung up before its body ended: nothing to answer
    req.once("close", () => {
      if (!req.complete) resolve(undefined);
    });
    req.once("error", reject);
  });
}

/** Writes each event until the stream ends or the connection is gone; an error as an error event. */
async function writeEvents(
  res: ServerResponse,
  iterator: AsyncIterator<unknown>,
  first: IteratorResult<unknown>,
  answer: { readonly id: unknown; readonly log: BindingLog },
): Promise<void> {
  try {
    for (let next = first; next.done !== true; next = await iterator.next()) {
      if (res.destroyed) break;
      res.write(formatSSEEvent(next.value));
    }
  } catch (error) {
    const event = errorAnswerOf(answer.id, error, answer.log);
    if (!res.writableEnded) res.write(formatSSEErrorEvent(event));
  }
}

/** Server-sent events: the first one decides — an error before it is one JSON answer. */
export async function sendEvents(
  res: ServerResponse,
  events: AsyncIterable<unknown>,
  answer: { readonly id: unknown; readonly log: BindingLog; readonly headers: AnswerHeaders },
): Promise<void> {
  const { headers } = answer;
  const iterator = events[Symbol.asyncIterator]();
  let first: IteratorResult<unknown>;
  try {
    first = await iterator.next();
  } catch (error) {
    sendJson(res, errorAnswerOf(answer.id, error, answer.log), headers);
    return;
  }
  res.writeHead(HTTP_OK, { ...SSE_HEADERS, ...headers });
  try {
    await writeEvents(res, iterator, first, answer);
  } finally {
    await iterator.return?.();
    if (!res.writableEnded) res.end();
  }
}

/** Serves the card, with its entity tag (`304` for the same one). */
export function sendCard(req: IncomingMessage, res: ServerResponse, card: ServedAgentCard): void {
  const headers = { etag: card.etag, "cache-control": "max-age=300" };
  if (req.headers["if-none-match"] === card.etag) {
    res.writeHead(HTTP_NOT_MODIFIED, headers).end();
    return;
  }
  res.writeHead(HTTP_OK, { "content-type": "application/json", ...headers }).end(card.json);
}
