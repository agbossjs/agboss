import { FinishReason } from "../../models/finish-reason.js";
import type { ModelProviderResponse } from "../../models/transport/transport.js";

/**
 * A model's answer cut at its token limit (`ChaosFailure.TruncatedResponse`, #396 PR 6): its text
 * and its tool calls' arguments to their first half, `finish_reason: "length"`. An HTTP answer is
 * an OpenAI-compatible JSON body; a streamed one (`text/event-stream`) or one that is not JSON is
 * left as it came — then nothing was injected.
 */

const half = (text: string): string => text.slice(0, Math.floor(text.length / 2));

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function truncatedToolCall(call: unknown): unknown {
  if (!isObject(call) || !isObject(call.function)) return call;
  const { arguments: args } = call.function;
  return typeof args === "string"
    ? { ...call, function: { ...call.function, arguments: half(args) } }
    : call;
}

function truncatedChoice(choice: unknown): unknown {
  if (!isObject(choice) || !isObject(choice.message)) return choice;
  const { content, tool_calls: toolCalls } = choice.message;
  const message = {
    ...choice.message,
    ...(typeof content === "string" ? { content: half(content) } : {}),
    ...(Array.isArray(toolCalls) ? { tool_calls: toolCalls.map(truncatedToolCall) } : {}),
  };
  return { ...choice, message, finish_reason: FinishReason.Length };
}

/** The body cut short; undefined when it is not a chat completion. */
function truncatedBody(text: string): string | undefined {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(body) || !Array.isArray(body.choices)) return undefined;
  return JSON.stringify({ ...body, choices: body.choices.map(truncatedChoice) });
}

/** An HTTP answer cut short, or undefined when it cannot be (streamed, not JSON, a failure). */
export async function truncatedHttpResponse(response: Response): Promise<Response | undefined> {
  const type = response.headers.get("content-type") ?? "";
  if (!response.ok || type.includes("event-stream")) return undefined;
  const body = truncatedBody(await response.clone().text());
  if (body === undefined) return undefined;
  await response.body?.cancel();
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

/** A transport's answer cut short: its text, and each tool call's arguments to their first keys. */
export function truncatedTransportResponse(answer: ModelProviderResponse): ModelProviderResponse {
  const toolCalls = answer.toolCalls?.map((call) => {
    const entries = Object.entries(call.arguments);
    return {
      ...call,
      arguments: Object.fromEntries(entries.slice(0, Math.floor(entries.length / 2))),
    };
  });
  return {
    ...answer,
    text: half(answer.text),
    ...(toolCalls === undefined ? {} : { toolCalls }),
    finishReason: FinishReason.Length,
  };
}
