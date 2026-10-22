import { callerFile } from "./call-site.js";
import type { Class, ResolvedAll, Token } from "./injection.js";
import { DecidedBy } from "../flow/decorators/router.js";
import type { GuardrailHandler } from "./guardrail-handler.js";
import { componentOf, recordComponent } from "./metadata.js";

/**
 * Guardrails (#120): safety checks at the model boundary of agents and model routers — they block,
 * judges correct. `@InputGuardrail` reads what a model reads in a visit (its input message, masked by
 * its PII policies), `@OutputGuardrail` what an agent answers. A model decides yes / no on the
 * guardrail's `prompt`; at P(yes) ≥ `threshold` the execution fails with `GuardrailBlockedError`
 * and its `refusal` goes to the sender. Listed in `guardrails: [...]` of `@Application`, `@Workflow`,
 * `@Agent` and `@Router` — lists add up, `excludeGuardrails` removes one for an agent or a router.
 * `decidedBy: DecidedBy.Code` (#383) decides by the class's `check(text)` instead (`GuardrailHandler`):
 * no model, no question, no threshold — the same refusal, error, levels and masked text.
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
  readonly refusal: () => string | Promise<string>;
}

/** What every guardrail declares. */
interface GuardrailBaseOptions<D extends readonly Token[]> {
  /** Ends with `-guardrail` (`legal-advice-guardrail`). */
  readonly name: string;
  readonly description: string;
  /** Constructor dependencies (a `GuardrailRefusal` or `GuardrailHandler` class's services), in order. */
  readonly deps?: D;
}

/** A guardrail its model decides (`DecidedBy.Model`, the default): a yes / no question. */
interface ModelGuardrailFields<D extends readonly Token[]> extends GuardrailBaseOptions<D> {
  /** Who decides (#383): its model — the default when absent. */
  readonly decidedBy?: DecidedBy.Model;
  /** The yes / no question: yes blocks. Inline, and / or files next to the class. */
  readonly prompt?: string;
  readonly promptUrls?: readonly string[];
  /** A decision model (Jev, …) or a chat model; `defaults.guardrail.model` when absent. */
  readonly model?: string;
  /** Blocks when the model is at least this sure, P(yes) ≥ threshold (0 < threshold ≤ 1). */
  readonly threshold: number;
}

/** A guardrail its class decides (`DecidedBy.Code`, #383): `check(text)`, no model, no question. */
interface CodeGuardrailFields<D extends readonly Token[]> extends GuardrailBaseOptions<D> {
  readonly decidedBy: DecidedBy.Code;
  readonly prompt?: never;
  readonly promptUrls?: never;
  readonly model?: never;
  readonly threshold?: never;
}

/** A model guardrail with a fixed refusal. */
export interface GuardrailTextOptions<
  D extends readonly Token[] = readonly Token[],
> extends ModelGuardrailFields<D> {
  /** The text sent instead when it blocks. */
  readonly refusal: string;
}

/** A model guardrail whose class computes its refusal (`implements GuardrailRefusal`). */
export interface GuardrailComputedOptions<
  D extends readonly Token[] = readonly Token[],
> extends ModelGuardrailFields<D> {
  readonly refusal?: never;
}

/** A code guardrail with a fixed refusal (`implements GuardrailHandler`). */
export interface CodeGuardrailTextOptions<
  D extends readonly Token[] = readonly Token[],
> extends CodeGuardrailFields<D> {
  /** The text sent instead when it blocks. */
  readonly refusal: string;
}

/** A code guardrail whose class computes its refusal too (`implements GuardrailHandler, GuardrailRefusal`). */
export interface CodeGuardrailComputedOptions<
  D extends readonly Token[] = readonly Token[],
> extends CodeGuardrailFields<D> {
  /** None: the class's `refusal()` gives it. */
  readonly refusal?: never;
}

/** A model guardrail's options, as recorded. */
export type ModelGuardrailOptions = GuardrailTextOptions | GuardrailComputedOptions;

/** A code guardrail's options, as recorded. */
export type CodeGuardrailOptions = CodeGuardrailTextOptions | CodeGuardrailComputedOptions;

/** Any form, as recorded: a union discriminated by `decidedBy` (absent = `DecidedBy.Model`). */
export type GuardrailOptions = ModelGuardrailOptions | CodeGuardrailOptions;

/** What `@InputGuardrail` / `@OutputGuardrail` recorded: the options, the side, the file. */
export type GuardrailMeta = GuardrailOptions & {
  readonly side: GuardrailSide;
  readonly deps: readonly Token[];
  readonly source?: string;
};

/** A recorded model guardrail. */
export type ModelGuardrailMeta = GuardrailMeta & ModelGuardrailOptions;

/** Whether a guardrail is decided by its class's `check(text)`. */
export const isCodeGuardrail = (options: GuardrailOptions): options is CodeGuardrailOptions =>
  options.decidedBy === DecidedBy.Code;

/** The class decorator of a guardrail: its constructor takes its `deps`, its instance is `T`. */
type GuardrailDecorator<D extends readonly Token[], T> = <
  C extends new (...args: ResolvedAll<D>) => T,
>(
  value: C,
) => C;

const guardrailDecorator =
  (side: GuardrailSide, options: GuardrailOptions, source: string | undefined) =>
  <C extends Class>(value: C): C => {
    const meta: GuardrailMeta = { ...options, side, deps: options.deps ?? [] };
    recordComponent(value, {
      kind: "guardrail",
      meta: source === undefined ? meta : { ...meta, source },
    });
    return value;
  };

/** `@InputGuardrail` decided by its model, with a fixed `refusal`. */
export function InputGuardrail<const D extends readonly Token[] = []>(
  options: GuardrailTextOptions<D>,
): GuardrailDecorator<D, object>;
/** `@InputGuardrail` decided by its model, without `refusal`: the class implements `GuardrailRefusal`. */
export function InputGuardrail<const D extends readonly Token[] = []>(
  options: GuardrailComputedOptions<D>,
): GuardrailDecorator<D, GuardrailRefusal>;
/** `@InputGuardrail` decided by code (#383): the class implements `GuardrailHandler`. */
export function InputGuardrail<const D extends readonly Token[] = []>(
  options: CodeGuardrailTextOptions<D>,
): GuardrailDecorator<D, GuardrailHandler>;
/** `@InputGuardrail` decided by code, without `refusal`: `GuardrailHandler` and `GuardrailRefusal`. */
export function InputGuardrail<const D extends readonly Token[] = []>(
  options: CodeGuardrailComputedOptions<D>,
): GuardrailDecorator<D, GuardrailHandler & GuardrailRefusal>;
export function InputGuardrail(options: GuardrailOptions): <C extends Class>(value: C) => C {
  return guardrailDecorator(GuardrailSide.Input, options, callerFile());
}

/** `@OutputGuardrail` decided by its model, with a fixed `refusal`. */
export function OutputGuardrail<const D extends readonly Token[] = []>(
  options: GuardrailTextOptions<D>,
): GuardrailDecorator<D, object>;
/** `@OutputGuardrail` decided by its model, without `refusal`: the class implements `GuardrailRefusal`. */
export function OutputGuardrail<const D extends readonly Token[] = []>(
  options: GuardrailComputedOptions<D>,
): GuardrailDecorator<D, GuardrailRefusal>;
/** `@OutputGuardrail` decided by code (#383): the class implements `GuardrailHandler`. */
export function OutputGuardrail<const D extends readonly Token[] = []>(
  options: CodeGuardrailTextOptions<D>,
): GuardrailDecorator<D, GuardrailHandler>;
/** `@OutputGuardrail` decided by code, without `refusal`: `GuardrailHandler` and `GuardrailRefusal`. */
export function OutputGuardrail<const D extends readonly Token[] = []>(
  options: CodeGuardrailComputedOptions<D>,
): GuardrailDecorator<D, GuardrailHandler & GuardrailRefusal>;
export function OutputGuardrail(options: GuardrailOptions): <C extends Class>(value: C) => C {
  return guardrailDecorator(GuardrailSide.Output, options, callerFile());
}

/** A class's guardrail record, if it is one. */
export const guardrailMetaOf = (cls: Class): GuardrailMeta | undefined => {
  const component = componentOf(cls);
  return component?.kind === "guardrail" ? component.meta : undefined;
};
