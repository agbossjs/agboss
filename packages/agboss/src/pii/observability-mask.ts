import { displayMask, maskedDtoValue } from "../dto/redact.js";
import type { DtoClass } from "../dto/types.js";
import { kindPlaceholder } from "./replacement.js";
import type { PiiPolicySet, SensitiveValue } from "./policy-set.js";
import { DetectionMode } from "./runtime-policy.js";
import { mappedStringsAsync } from "./strings.js";
import { BaseMessage } from "@langchain/core/messages";
import { maskedMessageOf } from "./message-mask.js";

/**
 * The observability boundary (#120 S38, AC7): logs, traces, observer events and `result.record`
 * masked with the application's and the workflow's policies — whatever an agent excludes — never
 * with a model (no call outside a step). A block rule shows its value as `<kind>` and fails
 * nothing. In a trace of the graph's state the execution's own PII channels are masked too: the
 * token map's values, the sensitive values and the context fields marked `sensitive`.
 */
export interface ObservabilityMask {
  /** A JSON-like value (an event, the record), every string masked; class instances kept. */
  value(value: unknown): Promise<unknown>;
  /** One line of the log, at once. */
  text(text: string): string;
  /** A trace attribute: JSON text masked as its value, any other text as text. */
  traceData(data: unknown): Promise<unknown>;
}

/** The context classes whose `sensitive` fields a trace of the state masks. */
export interface ObservedContexts {
  readonly tenantContext: abstract new () => unknown;
  readonly executionContext: abstract new () => unknown;
}

const isPlain = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hiddenTokens = (tokens: unknown): unknown =>
  isPlain(tokens)
    ? Object.fromEntries(
        Object.keys(tokens).map((token) => [
          token,
          kindPlaceholder(token.slice(1, token.indexOf(":"))),
        ]),
      )
    : tokens;

const hiddenValue = (item: unknown): unknown => {
  if (!isPlain(item)) return item;
  const { label } = item as Partial<SensitiveValue>;
  return { ...item, value: kindPlaceholder(label ?? "sensitive") };
};

const hiddenValues = (values: unknown): unknown =>
  Array.isArray(values) ? values.map(hiddenValue) : values;

function hiddenContexts(contexts: unknown, classes: ObservedContexts | undefined): unknown {
  if (classes === undefined || !isPlain(contexts)) return contexts;
  return {
    ...contexts,
    tenant: maskedDtoValue(classes.tenantContext as DtoClass, contexts.tenant, displayMask),
    execution: maskedDtoValue(
      classes.executionContext as DtoClass,
      contexts.execution,
      displayMask,
    ),
  };
}

/** An execution's key of field tokens as a trace shows it (#334): never the key. */
const HIDDEN_KEY = "***";

/** The execution's PII channels of a state hidden, wherever a state shows up in a trace. */
function withHiddenChannels(value: unknown, classes: ObservedContexts | undefined): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => withHiddenChannels(item, classes));
  if (!isPlain(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (key === "piiTokens") return [key, hiddenTokens(item)];
      if (key === "piiValues") return [key, hiddenValues(item)];
      if (key === "piiKey") return [key, typeof item === "string" ? HIDDEN_KEY : item];
      if (key === "contexts") return [key, hiddenContexts(item, classes)];
      return [key, withHiddenChannels(item, classes)];
    }),
  );
}

/**
 * The messages inside an event (a model call's `rawPayload`) are class instances the string walk
 * keeps as they are: each one rebuilt with its content and its calls' arguments masked.
 */
async function withMaskedMessages(
  data: unknown,
  mask: (text: string) => Promise<string>,
): Promise<unknown> {
  if (BaseMessage.isInstance(data)) return maskedMessageOf(data, mask);
  if (Array.isArray(data)) {
    const items: unknown[] = [];
    for (const item of data as readonly unknown[]) items.push(await withMaskedMessages(item, mask));
    return items;
  }
  if (!isPlain(data)) return data;
  const entries: [string, unknown][] = [];
  for (const [key, item] of Object.entries(data))
    entries.push([key, await withMaskedMessages(item, mask)]);
  return Object.fromEntries(entries);
}

const parsedJson = (text: string): { readonly value: unknown } | undefined => {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
};

/** The mask of a workflow's observability: its policies, and the context classes of its application. */
export function observabilityMaskOf(
  set: PiiPolicySet,
  contexts?: ObservedContexts,
): ObservabilityMask {
  const text = (line: string): string => set.maskNow(line);
  const maskText = async (item: string): Promise<string> =>
    (await set.mask(item, {}, DetectionMode.WithoutModel)).masked.text;
  const value = async (data: unknown): Promise<unknown> =>
    set.isEmpty ? data : mappedStringsAsync(await withMaskedMessages(data, maskText), maskText);
  return {
    value,
    text,
    traceData: async (data) => {
      if (typeof data !== "string") return value(withHiddenChannels(data, contexts));
      const json = parsedJson(data);
      if (json === undefined) return value(data);
      return JSON.stringify(await value(withHiddenChannels(json.value, contexts)));
    },
  };
}

/** A mask that keeps everything (a workflow without policies and without an application). */
export const NO_OBSERVABILITY_MASK: ObservabilityMask = {
  value: (data) => Promise.resolve(data),
  text: (line) => line,
  traceData: (data) => Promise.resolve(data),
};
