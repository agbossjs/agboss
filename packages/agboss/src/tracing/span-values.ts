import { SpanStatusCode, type AttributeValue } from "@opentelemetry/api";
import { MASK_FAILED, type OpenSpan } from "./app-trace.js";
import type { TraceMask } from "./types.js";
import { chainNamesOf } from "./workflow-chain.js";

/** What a span carries beyond what its start names: texts (and lists of texts) a run produced. */
export type SpanTexts = Readonly<Record<string, string | readonly string[]>>;

async function maskedText(text: string, masks: readonly TraceMask[]): Promise<string> {
  let shown: unknown = text;
  try {
    for (const mask of masks) shown = await mask.traceData(shown);
  } catch {
    return MASK_FAILED;
  }
  return typeof shown === "string" ? shown : MASK_FAILED;
}

/** A text, or each text of a list, through every mask: a list is masked item by item. */
async function maskedValue(
  value: string | readonly string[],
  masks: readonly TraceMask[],
): Promise<string | string[]> {
  if (typeof value === "string") return maskedText(value, masks);
  const shown: string[] = [];
  for (const item of value) shown.push(await maskedText(item, masks));
  return shown;
}

/**
 * `values` with every text masked — the only way a run's value gets onto a span: a mask that throws
 * or answers with anything but text leaves `MASK_FAILED`, never the value.
 */
export async function maskedAttributes(
  values: SpanTexts,
  masks: readonly TraceMask[],
): Promise<Record<string, AttributeValue>> {
  const shown: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(values)) shown[key] = await maskedValue(value, masks);
  return shown;
}

/** A value as the text a backend shows; one that cannot be written shows as such, never as itself. */
export function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    // `JSON.stringify(undefined)` is undefined at run time, whatever its type says
    const written: unknown = JSON.stringify(value);
    return typeof written === "string" ? written : "";
  } catch {
    return "[unserializable]";
  }
}

/** The usage a model's answer reports, when it does: token counts are numbers, not data. */
export function usageOf(output: unknown): Record<string, number> {
  const generations = (output as { generations?: unknown } | null)?.generations;
  const group: unknown = Array.isArray(generations) ? generations[0] : undefined;
  const first: unknown = Array.isArray(group) ? group[0] : undefined;
  const usage = (first as { message?: { usage_metadata?: Record<string, unknown> } } | undefined)
    ?.message?.usage_metadata;
  const attributes: Record<string, number> = {};
  if (typeof usage?.input_tokens === "number")
    attributes["gen_ai.usage.input_tokens"] = usage.input_tokens;
  if (typeof usage?.output_tokens === "number")
    attributes["gen_ai.usage.output_tokens"] = usage.output_tokens;
  return attributes;
}

/** A run's name when LangChain gave none: the last part of its serialized id (a class name). */
export function serializedName(serialized: unknown): string {
  const id = (serialized as { id?: unknown } | null)?.id;
  const last: unknown = Array.isArray(id) ? id[id.length - 1] : undefined;
  return typeof last === "string" ? last : "run";
}

/** The model a call asked for: LangChain's own metadata first, then the call's invocation params. */
export function modelOf(
  extra: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const named = metadata?.ls_model_name;
  if (typeof named === "string") return named;
  const invocation = extra?.invocation_params as
    { model?: unknown; model_name?: unknown } | undefined;
  const model = invocation?.model ?? invocation?.model_name;
  return typeof model === "string" ? model : undefined;
}

/** The workflows a step's spans are masked by: its chain (#1150), else its own workflow's name. */
export function chainOf(metadata: Readonly<Record<string, unknown>> | undefined): {
  readonly workflow: string | undefined;
  readonly chain: readonly string[] | undefined;
} {
  const named = typeof metadata?.workflowName === "string" ? metadata.workflowName : undefined;
  const chain =
    chainNamesOf(metadata?.workflowChain) ?? (named === undefined ? undefined : [named]);
  return { workflow: named, chain };
}

/** The texts a span starts with: the run's input, its model, tags and metadata, then its trace fields. */
export function startTexts(
  start: {
    readonly input: unknown;
    readonly metadata: Readonly<Record<string, unknown>> | undefined;
    readonly tags: readonly string[] | undefined;
    readonly model?: string | undefined;
  },
  trace:
    { readonly threadId: string; readonly tenantId: string; readonly runId: string } | undefined,
): SpanTexts {
  const texts: Record<string, string | readonly string[]> = { "input.value": textOf(start.input) };
  if (start.model !== undefined) texts["gen_ai.request.model"] = start.model;
  if (start.tags !== undefined && start.tags.length > 0) texts["tag.tags"] = start.tags;
  for (const [key, value] of Object.entries(start.metadata ?? {}))
    texts[`agboss.metadata.${key}`] = textOf(value);
  // the trace's own fields go on the first span of the run: its session is the thread
  if (trace !== undefined) {
    texts["session.id"] = trace.threadId;
    texts["agboss.tenant.id"] = trace.tenantId;
    texts["agboss.run.id"] = trace.runId;
  }
  return texts;
}

/** How a run ended: its output, or its error; the numbers a model call reports. */
export interface RunEnd {
  readonly output?: unknown;
  readonly error?: unknown;
  readonly numbers?: Record<string, number>;
}

/** Sets what a run ended with on its span — its texts masked like every other — before it ends. */
export async function recordEnd({ span, masks }: OpenSpan, end: RunEnd): Promise<void> {
  if (end.numbers !== undefined) span.setAttributes(end.numbers);
  if (end.output !== undefined)
    span.setAttributes(await maskedAttributes({ "output.value": textOf(end.output) }, masks));
  if (end.error === undefined) return;
  const error = end.error instanceof Error ? end.error : new Error(textOf(end.error));
  const shown = await maskedAttributes(
    { "exception.type": error.name, "exception.message": error.message },
    masks,
  );
  span.addEvent("exception", shown);
  span.setStatus({ code: SpanStatusCode.ERROR, message: String(shown["exception.message"]) });
}
