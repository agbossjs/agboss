import { callerFile } from "./call-site.js";
import type { Class, ResolvedAll, Token } from "./injection.js";
import { componentOf, recordComponent } from "./metadata.js";

/**
 * Guardrails (#120): safety checks at the model boundary of agents and model routers — they block,
 * judges correct. `@InputGuardrail` reads what a model reads in a visit (its input message, masked by
 * its PII policies), `@OutputGuardrail` what an agent answers. A model decides yes / no on the
 * guardrail's `prompt`; at P(yes) ≥ `threshold` the execution fails with `GuardrailBlockedError`
 * and its `refusal` goes to the sender. Listed in `guardrails: [...]` of `@Application`, `@Workflow`,
 * `@Agent` and `@Router` — lists add up, `excludeGuardrails` removes one for an agent or a router.
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

/** What both forms of a guardrail declare. */
interface GuardrailBaseOptions<D extends readonly Token[]> {
  /** Ends with `-guardrail` (`legal-advice-guardrail`). */
  readonly name: string;
  readonly description: string;
  /** The yes / no question: yes blocks. Inline, and / or files next to the class. */
  readonly prompt?: string;
  readonly promptUrls?: readonly string[];
  /** A decision model (Jev, …) or a chat model; `defaults.guardrail.model` when absent. */
  readonly model?: string;
  /** Blocks when the model is at least this sure, P(yes) ≥ threshold (0 < threshold ≤ 1). */
  readonly threshold: number;
  /** Constructor dependencies (a `GuardrailRefusal` class's services), in order. */
  readonly deps?: D;
}

/** A guardrail with a fixed refusal. */
export interface GuardrailTextOptions<
  D extends readonly Token[] = readonly Token[],
> extends GuardrailBaseOptions<D> {
  /** The text sent instead when it blocks. */
  readonly refusal: string;
}

/** A guardrail whose class computes its refusal (`implements GuardrailRefusal`). */
export interface GuardrailComputedOptions<
  D extends readonly Token[] = readonly Token[],
> extends GuardrailBaseOptions<D> {
  readonly refusal?: never;
}

/** Either form, as recorded. */
export type GuardrailOptions = GuardrailTextOptions | GuardrailComputedOptions;

/** What `@InputGuardrail` / `@OutputGuardrail` recorded: the options, the side, the file. */
export type GuardrailMeta = GuardrailOptions & {
  readonly side: GuardrailSide;
  readonly deps: readonly Token[];
  readonly source?: string;
};

/** The class decorator of a guardrail with a fixed refusal: any class with its `deps`. */
type TextGuardrailDecorator<D extends readonly Token[]> = <
  C extends new (...args: ResolvedAll<D>) => object,
>(
  value: C,
) => C;

/** The class decorator of a guardrail without one: the class implements `GuardrailRefusal`. */
type ComputedGuardrailDecorator<D extends readonly Token[]> = <
  C extends new (...args: ResolvedAll<D>) => GuardrailRefusal,
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

/** `@InputGuardrail` with a fixed `refusal`. */
export function InputGuardrail<const D extends readonly Token[] = []>(
  options: GuardrailTextOptions<D>,
): TextGuardrailDecorator<D>;
/** `@InputGuardrail` without `refusal`: the class implements `GuardrailRefusal`. */
export function InputGuardrail<const D extends readonly Token[] = []>(
  options: GuardrailComputedOptions<D>,
): ComputedGuardrailDecorator<D>;
export function InputGuardrail(options: GuardrailOptions): <C extends Class>(value: C) => C {
  return guardrailDecorator(GuardrailSide.Input, options, callerFile());
}

/** `@OutputGuardrail` with a fixed `refusal`. */
export function OutputGuardrail<const D extends readonly Token[] = []>(
  options: GuardrailTextOptions<D>,
): TextGuardrailDecorator<D>;
/** `@OutputGuardrail` without `refusal`: the class implements `GuardrailRefusal`. */
export function OutputGuardrail<const D extends readonly Token[] = []>(
  options: GuardrailComputedOptions<D>,
): ComputedGuardrailDecorator<D>;
export function OutputGuardrail(options: GuardrailOptions): <C extends Class>(value: C) => C {
  return guardrailDecorator(GuardrailSide.Output, options, callerFile());
}

/** A class's guardrail record, if it is one. */
export const guardrailMetaOf = (cls: Class): GuardrailMeta | undefined => {
  const component = componentOf(cls);
  return component?.kind === "guardrail" ? component.meta : undefined;
};
