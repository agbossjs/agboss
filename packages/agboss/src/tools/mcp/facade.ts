import { z } from "zod";
import { defineTool } from "../define-tool.js";
import type { Tool } from "../types.js";
import type { Milliseconds } from "../../units/index.js";
import { McpError } from "../../core/error-families/remote-errors.js";
import { MESH_ERROR_META_KEY } from "../../mesh/mesh-envelope.js";
import { meshLimitErrorOf } from "../../mesh/mesh-wire.js";

/** Calls a tool on a connected server and returns the raw MCP result. */
export type McpCaller = (
  tool: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

/** Where a facade points: server name and the tool's name on that server. */
export interface McpToolRef {
  readonly server: string;
  readonly tool: string;
}

/** A typed tool backed by an MCP server tool. Name as seen by agents: `<server>__<tool>`. */
export interface McpFacade<
  TName extends string = string,
  TInput = unknown,
  TOutput = unknown,
> extends Tool<TName, TInput, TOutput> {
  readonly mcp: McpToolRef;
}

/** MCP tool arguments are always an object, so the input type is one too. */
export interface McpFacadeDefinition<
  TTool extends string,
  TInput extends Record<string, unknown>,
  TOutput,
> {
  readonly tool: TTool;
  readonly description: string;
  readonly input: z.ZodType<TInput>;
  /** Required. `z.string()` or an object of one field `text` for text only the model reads. */
  readonly output: z.ZodType<TOutput>;
  readonly timeout?: Milliseconds;
}

/** What a handle knows of its server beyond the name. */
export interface McpServerHandleOptions {
  /** The headers the server's class adds per HTTP request (`getHeaders`). */
  readonly headers?: () => Promise<Record<string, string>>;
  /** How long one call of its tools may run. */
  readonly timeout?: Milliseconds;
}

/** A declared MCP server: produces facades, gets its caller bound at startup. */
export interface McpServerHandle<TServer extends string> {
  readonly name: TServer;
  /** The headers its class adds per HTTP request. */
  readonly headers: () => Promise<Record<string, string>>;
  readonly tool: <TTool extends string, TInput extends Record<string, unknown>, TOutput>(
    definition: McpFacadeDefinition<TTool, TInput, TOutput>,
  ) => McpFacade<`${TServer}__${TTool}`, TInput, TOutput>;
  readonly bind: (caller: McpCaller | undefined) => void;
}

const CallResultSchema = z.object({
  isError: z.boolean().optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
  structuredContent: z.unknown().optional(),
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).default([]),
});

const textOf = (content: z.infer<typeof CallResultSchema>["content"]): string =>
  content.map((part) => part.text ?? "").join("");

/** An output of one field `text` (e.g. `PlainTextDto`): the server's text as is. */
const isTextOutput = (output: z.ZodType): boolean =>
  output instanceof z.ZodObject && Object.keys(output.shape).join() === "text";

/**
 * Maps an MCP call result to the facade's output value; errors become thrown messages. Structured
 * content wins; text goes as is to a string or a `{ text }` output, otherwise it is parsed as JSON.
 */
export function mcpResultValue(raw: unknown, output: z.ZodType): unknown {
  const parsed = CallResultSchema.safeParse(raw);
  if (!parsed.success) throw new McpError.Contract();
  const result = parsed.data;
  const text = textOf(result.content);
  if (result.isError === true) {
    // a mesh limit an AGBoss server met (#398): the calling step fails with the same limit; any other
    // failure of the server's tool is `McpError.Unavailable` — never the server's own text
    throw meshLimitErrorOf(result._meta?.[MESH_ERROR_META_KEY]) ?? new McpError.Unavailable();
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (output instanceof z.ZodString) return text;
  if (isTextOutput(output)) return { text };
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    throw new McpError.Contract();
  }
}

/** Declares an MCP server by name. Its connection is the `@McpServer`'s. */
export function mcpServer<TServer extends string>(
  name: TServer,
  options: McpServerHandleOptions = {},
): McpServerHandle<TServer> {
  let caller: McpCaller | undefined;
  return {
    name,
    headers: options.headers ?? (() => Promise.resolve({})),
    bind: (next) => {
      caller = next;
    },
    tool: (definition) => {
      const facade = defineTool({
        name: `${name}__${definition.tool}` as const,
        description: definition.description,
        input: definition.input,
        output: definition.output,
        timeout: definition.timeout ?? options.timeout,
        run: async (input, ctx) => {
          if (caller === undefined) throw new McpError.Unavailable();
          const raw = await caller(definition.tool, input, ctx.signal);
          const parsed = definition.output.safeParse(mcpResultValue(raw, definition.output));
          if (!parsed.success) throw new McpError.Contract();
          return parsed.data;
        },
      });
      return { ...facade, mcp: { server: name, tool: definition.tool } };
    },
  };
}

export const isMcpFacade = (tool: Tool): tool is McpFacade => "mcp" in tool;
