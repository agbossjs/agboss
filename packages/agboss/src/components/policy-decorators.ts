import type { PromptVariables } from "./prompt-variables.js";
import type { PromptSource } from "./prompt-source.js";
import { callerFile } from "./call-site.js";
import type { Class, ResolvedAll, Token } from "./injection.js";
import type { GuardrailContent, GuardrailHandler } from "./guardrail-handler.js";
import { componentOf, recordComponent } from "./metadata.js";
import { resolvedName } from "../flow/names.js";

/**
 * Guardrails (#120): safety checks at the model boundary of agents and model routers — they block,
 * judges correct. `@InputGuardrail` reads what a model reads in a visit (its input message, masked by
 * its PII policies), `@OutputGuardrail` what an agent answers. A model decides yes / no on the
 * guardrail's `prompt`; at P(yes) ≥ `threshold` the execution fails with `GuardrailBlockedError`
 * and its `refusal` goes to the sender. Listed in `guardrails: [...]` of `@Application`, `@Workflow`,
 * `@Agent` and `@Router` — lists add up, `excludeGuardrails` removes one for an agent or a router.
 * A class that sets no question, threshold or model decides by its `check(content)` instead (#383,
 * `GuardrailHandler`): no model, cost 0 — the same refusal, error, levels and masked text.
 */

/** What a guardrail reads: what comes into a model, or what an agent answers. */
export enum GuardrailSide {
  Input = "input",
  Output = "output",
}

/**
 * The text of a guardrail without `refusal` in its decorator: computed when it blocks (the sender's
 * language, wording kept in a CMS) — the execution through `deps: [ExecutionContext]`.
 */
export interface GuardrailRefusal {
  /** The text sent instead; `content` is what the guardrail checked (the locale, the CMS key it reads). */
  readonly refusal: (content: GuardrailContent) => string | Promise<string>;
}

/** A model guardrail with a fixed refusal. */
export interface GuardrailTextOptions<D extends readonly Token[] = readonly Token[]> {
  /** Kebab-case; the class name in kebab-case when left out (`LegalAdvice` → `legal-advice`). */
  readonly name?: string;
  readonly description?: string;
  /** Constructor dependencies (a `GuardrailRefusal` or `GuardrailHandler` class's services), in order. */
  readonly deps?: D;
  /** The yes / no question: yes blocks. Inline, and / or files next to the class. */
  readonly prompt?: PromptSource;
  readonly promptUrls?: readonly string[];
  /** Static `{{key}}` values of this prompt, over the workflow's and the application's. */
  readonly promptVariables?: PromptVariables;
  /**
   * A decision model or a chat model: a vendor name, or a role of its provider (`"fast"`). Left
   * out: `defaults.guardrail.model`, else the default model of its provider (#1313).
   */
  readonly model?: string;
  /** The `@ModelProvider` class its model is served from; left out: its workflow's, its application's (#1313). */
  readonly modelProvider?: Class;
  /** Blocks when the model is at least this sure, P(yes) ≥ threshold (0 < threshold ≤ 1). */
  readonly threshold: number;
  /** The text sent instead when it blocks. */
  readonly refusal: string;
}

/** A model guardrail whose class computes its refusal (`implements GuardrailRefusal`). */
export interface GuardrailComputedOptions<D extends readonly Token[] = readonly Token[]> {
  /** Kebab-case; the class name in kebab-case when left out (`LegalAdvice` → `legal-advice`). */
  readonly name?: string;
  readonly description?: string;
  /** Constructor dependencies (a `GuardrailRefusal` or `GuardrailHandler` class's services), in order. */
  readonly deps?: D;
  /** The yes / no question: yes blocks. Inline, and / or files next to the class. */
  readonly prompt?: PromptSource;
  readonly promptUrls?: readonly string[];
  /** Static `{{key}}` values of this prompt, over the workflow's and the application's. */
  readonly promptVariables?: PromptVariables;
  /**
   * A decision model or a chat model: a vendor name, or a role of its provider (`"fast"`). Left
   * out: `defaults.guardrail.model`, else the default model of its provider (#1313).
   */
  readonly model?: string;
  /** The `@ModelProvider` class its model is served from; left out: its workflow's, its application's (#1313). */
  readonly modelProvider?: Class;
  /** Blocks when the model is at least this sure, P(yes) ≥ threshold (0 < threshold ≤ 1). */
  readonly threshold: number;
  readonly refusal?: never;
}

/**
 * A code guardrail: no `prompt`, `threshold` or `model`; its class has `check(content)` — no model, cost
 * 0. `refusal` is the text sent when `GuardrailVerdict.blocked()` names none; the class's `refusal(content)` gives it
 * instead; a `blocked()` with neither fails closed.
 */
export interface CodeGuardrailTextOptions<D extends readonly Token[] = readonly Token[]> {
  /** Kebab-case; the class name in kebab-case when left out (`LegalAdvice` → `legal-advice`). */
  readonly name?: string;
  readonly description?: string;
  /** Constructor dependencies (a `GuardrailRefusal` or `GuardrailHandler` class's services), in order. */
  readonly deps?: D;
  readonly prompt?: never;
  readonly promptUrls?: never;
  readonly promptVariables?: never;
  readonly model?: never;
  readonly modelProvider?: never;
  readonly threshold?: never;
  /** The text sent when `blocked()` names none. */
  readonly refusal?: string;
}

/** A model guardrail's options, as recorded. */
export type ModelGuardrailOptions = GuardrailTextOptions | GuardrailComputedOptions;

/** A code guardrail's options, as recorded. */
export type CodeGuardrailOptions = CodeGuardrailTextOptions;

/**
 * Any form, as recorded: a model guardrail asks a question (`prompt`, `threshold`), a code guardrail
 * sets none of them and decides by its class's `check(content)`.
 */
export type GuardrailOptions = ModelGuardrailOptions | CodeGuardrailOptions;

/** What `@InputGuardrail` / `@OutputGuardrail` recorded: the options, the side, the file. */
export type GuardrailMeta = GuardrailOptions & {
  /** Given, or the class name in kebab-case. */
  readonly name: string;
  readonly side: GuardrailSide;
  readonly deps: readonly Token[];
  readonly source?: string;
};

/** A recorded model guardrail. */
export type ModelGuardrailMeta = GuardrailMeta & ModelGuardrailOptions;

/** Whether a guardrail is decided by its class's `check(content)`: it sets no question, threshold or model. */
export const isCodeGuardrail = (options: GuardrailOptions): options is CodeGuardrailOptions => {
  const { prompt, promptUrls, threshold, model, modelProvider }: Partial<GuardrailTextOptions> =
    options;
  return [prompt, promptUrls, threshold, model, modelProvider].every((set) => set === undefined);
};

/** The class decorator of a guardrail: its constructor takes its `deps`, its instance is `T`. */
export type GuardrailDecorator<D extends readonly Token[], T> = <
  C extends new (...args: ResolvedAll<D>) => T,
>(
  value: C,
) => C;

const guardrailDecorator =
  (side: GuardrailSide, options: GuardrailOptions, source: string | undefined) =>
  <C extends Class>(value: C): C => {
    const meta: GuardrailMeta = {
      ...options,
      name: resolvedName(options.name, value),
      side,
      deps: options.deps ?? [],
    };
    recordComponent(value, {
      kind: "guardrail",
      meta: source === undefined ? meta : { ...meta, source },
    });
    return value;
  };

/** A model guardrail's class asks its model: it has no `check(content)` (that is a code guardrail's). */
export type ModelGuardrailInstance = object & { readonly check?: never };

/** `@InputGuardrail` decided by its model, with a fixed `refusal`. */
export function InputGuardrail<const D extends readonly Token[] = []>(
  options: GuardrailTextOptions<D>,
): GuardrailDecorator<D, ModelGuardrailInstance>;
/** `@InputGuardrail` decided by its model, without `refusal`: the class implements `GuardrailRefusal`. */
export function InputGuardrail<const D extends readonly Token[] = []>(
  options: GuardrailComputedOptions<D>,
): GuardrailDecorator<D, GuardrailRefusal & ModelGuardrailInstance>;
/** `@InputGuardrail` decided by code (#383): no question, threshold or model; the class has `check(content)`. */
export function InputGuardrail<const D extends readonly Token[] = []>(
  options?: CodeGuardrailTextOptions<D>,
): GuardrailDecorator<D, GuardrailHandler>;
export function InputGuardrail(options: GuardrailOptions = {}): <C extends Class>(value: C) => C {
  return guardrailDecorator(GuardrailSide.Input, options, callerFile());
}

/** `@OutputGuardrail` decided by its model, with a fixed `refusal`. */
export function OutputGuardrail<const D extends readonly Token[] = []>(
  options: GuardrailTextOptions<D>,
): GuardrailDecorator<D, ModelGuardrailInstance>;
/** `@OutputGuardrail` decided by its model, without `refusal`: the class implements `GuardrailRefusal`. */
export function OutputGuardrail<const D extends readonly Token[] = []>(
  options: GuardrailComputedOptions<D>,
): GuardrailDecorator<D, GuardrailRefusal & ModelGuardrailInstance>;
/** `@OutputGuardrail` decided by code (#383): no question, threshold or model; the class has `check(content)`. */
export function OutputGuardrail<const D extends readonly Token[] = []>(
  options?: CodeGuardrailTextOptions<D>,
): GuardrailDecorator<D, GuardrailHandler>;
export function OutputGuardrail(options: GuardrailOptions = {}): <C extends Class>(value: C) => C {
  return guardrailDecorator(GuardrailSide.Output, options, callerFile());
}

/** A class's guardrail record, if it is one. */
export const guardrailMetaOf = (cls: Class): GuardrailMeta | undefined => {
  const component = componentOf(cls);
  return component?.kind === "guardrail" ? component.meta : undefined;
};
