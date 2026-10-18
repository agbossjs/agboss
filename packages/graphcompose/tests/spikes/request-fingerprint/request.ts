import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { z } from "zod";
import { MODEL_MAX } from "../../../src/config/types.js";
import { toLangChainTool, type ToolContext } from "../../../src/tools/index.js";
import type { JsonValue } from "./canonical-json.js";
import { schemaOf, type DtoClass } from "./dto.js";
import {
  joinPromptParts,
  loadPrompt,
  type ComponentLocation,
  type PromptText,
} from "./prompt-text.js";

/**
 * Spike #115 — the assembled model request: what a model receives from one element, minus the
 * run's input (messages). Built from decorator-like specs; this is what the fingerprint hashes.
 */

/** Bumped by hand when the framework lays the request out differently (message order, framing). */
export const REQUEST_ASSEMBLY_VERSION = 1;

export type JsonObject = Readonly<Record<string, JsonValue | undefined>>;
export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

/** Model settings as declared or inherited. Transport settings (`timeoutMs`) never reach the model. */
export interface ModelSettings {
  readonly provider: string;
  readonly model: string;
  readonly temperature?: number;
  readonly reasoningEffort?: ReasoningEffort;
  readonly maxTokens?: number | typeof MODEL_MAX;
  readonly requestFields?: JsonObject;
  readonly timeoutMs?: number;
}

/** What `@Tool` declares. `description` is for people; `prompt` + `promptUrls` for the model. */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly promptUrls?: readonly string[];
  readonly input: DtoClass;
  readonly location: ComponentLocation;
}

export interface AgentSpec {
  readonly description: string;
  readonly promptUrls: readonly string[];
  readonly location: ComponentLocation;
  readonly settings: Partial<ModelSettings>;
  readonly tools: readonly ToolSpec[];
  readonly answer?: DtoClass;
}

export interface RouteSpec {
  readonly target: string;
  readonly prompt: string;
}

export interface RouterSpec {
  readonly description: string;
  readonly promptUrls: readonly string[];
  readonly location: ComponentLocation;
  readonly settings: Partial<ModelSettings>;
  readonly routes: readonly RouteSpec[];
}

/** Provider + model + the parameters sent with every call (snake_case, as on the wire). */
export interface ModelRequest {
  readonly provider: string;
  readonly model: string;
  readonly parameters: JsonObject;
}

/** A tool as the provider adapter serialises it for the model. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
}

export interface AgentRequest {
  readonly kind: "agent";
  readonly prompt: PromptText;
  readonly model: ModelRequest;
  readonly tools: readonly ToolDefinition[];
  readonly answerSchema: JsonObject | null;
  readonly assemblyVersion: number;
}

export interface RouteChoice {
  readonly name: string;
  readonly prompt: PromptText;
}

export interface RouterRequest {
  readonly kind: "router";
  readonly prompt: PromptText;
  readonly model: ModelRequest;
  readonly routes: readonly RouteChoice[];
  readonly assemblyVersion: number;
}

export type ElementRequest = AgentRequest | RouterRequest;

const JsonObjectSchema = z.record(z.string(), z.json());
const NO_CONTEXT: ToolContext = {
  runId: "fingerprint",
  workflow: "fingerprint",
  agent: "fingerprint",
  signal: new AbortController().signal,
  reportCost: () => undefined,
};

/** Effective settings: declared values over inherited ones, resolved before hashing. */
export function modelRequest(
  declared: Partial<ModelSettings>,
  inherited: ModelSettings,
): ModelRequest {
  const settings: ModelSettings = { ...inherited, ...declared };
  const parameters: JsonObject = {
    ...settings.requestFields,
    temperature: settings.temperature,
    reasoning_effort: settings.reasoningEffort,
    max_tokens: settings.maxTokens === MODEL_MAX ? undefined : settings.maxTokens,
  };
  return { provider: settings.provider, model: settings.model, parameters };
}

/** The framework's own path (`toLangChainTool`) and LangChain's OpenAI serialisation. */
export async function toolDefinition(spec: ToolSpec): Promise<ToolDefinition> {
  const description = await loadPrompt(spec.location, spec.promptUrls ?? [], spec.prompt);
  const tool = toLangChainTool(
    {
      name: spec.name,
      description,
      effect: "read",
      timeoutMs: 1_000,
      input: schemaOf(spec.input),
      output: z.unknown(),
      invoke: () => Promise.resolve({ kind: "ok", value: null }),
    },
    NO_CONTEXT,
  );
  const wire = convertToOpenAITool(tool).function;
  const parameters = JsonObjectSchema.parse(wire.parameters);
  return { name: wire.name, description: wire.description ?? "", parameters };
}

const byName = <T extends { readonly name: string }>(a: T, b: T): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

export async function assembleAgent(
  spec: AgentSpec,
  inherited: ModelSettings,
): Promise<AgentRequest> {
  const tools = await Promise.all(spec.tools.map(toolDefinition));
  const answer = spec.answer === undefined ? null : z.toJSONSchema(schemaOf(spec.answer));
  return {
    kind: "agent",
    prompt: await loadPrompt(spec.location, spec.promptUrls),
    model: modelRequest(spec.settings, inherited),
    tools: [...tools].sort(byName), // sent in a canonical order: declaration order is incidental
    answerSchema: answer === null ? null : JsonObjectSchema.parse(answer),
    assemblyVersion: REQUEST_ASSEMBLY_VERSION,
  };
}

export async function assembleRouter(
  spec: RouterSpec,
  inherited: ModelSettings,
): Promise<RouterRequest> {
  const routes = spec.routes.map((route) => ({
    name: route.target,
    prompt: joinPromptParts([route.prompt]),
  }));
  return {
    kind: "router",
    prompt: await loadPrompt(spec.location, spec.promptUrls),
    model: modelRequest(spec.settings, inherited),
    routes: [...routes].sort(byName),
    assemblyVersion: REQUEST_ASSEMBLY_VERSION,
  };
}
