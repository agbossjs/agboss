import { z } from "zod";
import { compareNames } from "../llm/canonical-order.js";
import { CachedPart } from "./prompt-caching.js";

/** Anthropic-style cache marker; `ttl` only for a retention longer than five minutes. */
export interface CacheControl {
  readonly type: "ephemeral";
  readonly ttl?: string;
}

export interface WireContentPart {
  readonly type: string;
  readonly text?: string;
  readonly cache_control?: CacheControl;
}

export interface WireMessage {
  readonly role: string;
  readonly content?: string | readonly WireContentPart[] | null;
}

export interface WireFunction {
  readonly name: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
}

export interface WireTool {
  readonly type: string;
  readonly function: WireFunction;
}

/** A chat completion request body as it goes over the wire (fields the adapter does not read pass through). */
export interface WireRequest {
  readonly model: string;
  readonly messages?: readonly WireMessage[];
  readonly tools?: readonly WireTool[];
  readonly [field: string]: unknown;
}

/** What the adapter adds to a request: fields, and where cache markers go (none = no markers). */
export interface WirePlan {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly cacheMarkers: readonly CachedPart[];
  readonly cacheControl: CacheControl;
}

const WireRequestSchema = z.looseObject({ model: z.string() });

/** A request body from the client; anything but a JSON object with a model passes through untouched. */
export function parseWireRequest(body: string): WireRequest | undefined {
  try {
    const parsed = WireRequestSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const withoutSchemaKey = (tool: WireTool): WireTool => {
  if (tool.function.parameters === undefined) return tool;
  const parameters = Object.fromEntries(
    Object.entries(tool.function.parameters).filter(([key]) => key !== "$schema"),
  );
  return { ...tool, function: { ...tool.function, parameters } };
};

/** Tools in a canonical order (by name), their JSON Schemas without `$schema`. */
export const canonicalTools = (tools: readonly WireTool[]): readonly WireTool[] =>
  [...tools].sort((a, b) => compareNames(a.function.name, b.function.name)).map(withoutSchemaKey);

const marked = (message: WireMessage, control: CacheControl): WireMessage => {
  const content = message.content;
  if (typeof content === "string") {
    return { ...message, content: [{ type: "text", text: content, cache_control: control }] };
  }
  if (content === undefined || content === null || content.length === 0) return message;
  const last = content.length - 1;
  return {
    ...message,
    content: content.map((part, index) =>
      index === last ? { ...part, cache_control: control } : part,
    ),
  };
};

const hasText = (message: WireMessage): boolean =>
  typeof message.content === "string" ? message.content !== "" : (message.content?.length ?? 0) > 0;

/** Indexes of the messages that get a marker: the system prompt (it ends the tools + system prefix), the previous turn's end. */
function markerIndexes(
  messages: readonly WireMessage[],
  parts: readonly CachedPart[],
): Set<number> {
  const indexes = new Set<number>();
  const system = messages.findIndex((message) => message.role === "system");
  if (
    system !== -1 &&
    (parts.includes(CachedPart.SystemPrompt) || parts.includes(CachedPart.Tools))
  ) {
    indexes.add(system);
  }
  if (parts.includes(CachedPart.History)) {
    const lastUser = messages.findLastIndex((message) => message.role === "user");
    const previous = messages
      .slice(0, Math.max(0, lastUser))
      .findLastIndex((message, index) => index !== system && hasText(message));
    if (previous !== -1) indexes.add(previous);
  }
  return indexes;
}

/**
 * The exact body a provider sends, made in one place: tools sorted by name (declaration order changes
 * nothing), the provider's fields, reasoning and caching fields, and cache markers where the model
 * needs them. Fingerprints (#125) hash this body.
 */
export function toWireRequest(request: WireRequest, plan: WirePlan): WireRequest {
  const messages = request.messages;
  const markers =
    messages === undefined ? new Set<number>() : markerIndexes(messages, plan.cacheMarkers);
  return {
    ...request,
    ...(messages === undefined
      ? {}
      : {
          messages: messages.map((message, index) =>
            markers.has(index) ? marked(message, plan.cacheControl) : message,
          ),
        }),
    ...(request.tools === undefined ? {} : { tools: canonicalTools(request.tools) }),
    ...plan.fields,
  };
}

/** A client that sends every JSON request through `toWireRequest`. */
export function wireFetch(plan: WirePlan, send: typeof fetch): typeof fetch {
  return (input, init) => {
    const body = typeof init?.body === "string" ? parseWireRequest(init.body) : undefined;
    return body === undefined
      ? send(input, init)
      : send(input, { ...init, body: JSON.stringify(toWireRequest(body, plan)) });
  };
}
