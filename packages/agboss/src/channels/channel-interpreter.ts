import type { PromptVariables } from "../components/prompt-variables.js";
import { callerFile } from "../components/call-site.js";
import type { PromptValue } from "../components/prompt-source.js";
import type { Class, ResolvedAll, Token } from "../components/injection.js";
import { DecidedBy } from "../flow/decorators/router.js";
import type { InputOf, OutputOf } from "../flow/generated-types.js";
import { resolvedName } from "../flow/names.js";
import {
  recordInterpreter,
  ReplyInterpretationKind,
  type ReplyInterpreterDeclaration,
} from "./channel-role.decorator.js";

/**
 * `@ChannelInterpreter` (#1310c): the new name of `@ReplyInterpreter` — who turns a free-text reply
 * to a pause into its target's typed output, named on the target (`@ToolApproval({
 * channelInterpreter })`). No `decidedBy`: a class with `interpret(input)` decides by code, an empty
 * one with a `prompt` by its chat `model`. It records into the registry `@ReplyInterpreter` fills,
 * so assembly and the runtime read one shape.
 */

declare const channelInterpretation: unique symbol;

/** The reply was read as `output`. */
export interface UnderstoodChannelInterpretation<out TOutput> {
  /** A mark only `ChannelInterpretation.understood` / `.notUnderstood` give. */
  readonly [channelInterpretation]: true;
  readonly kind: ReplyInterpretationKind.Understood;
  readonly output: TOutput;
}

/** The reply was not understood: `reason` is the `UninterpretableReplyError`'s. */
export interface NotUnderstoodChannelInterpretation {
  readonly [channelInterpretation]: true;
  readonly kind: ReplyInterpretationKind.NotUnderstood;
  readonly reason: string;
}

/** What `interpret` returns: `ChannelInterpretation.understood(…)` or `.notUnderstood(reason)`. */
export type ChannelInterpretation<TOutput = never> =
  UnderstoodChannelInterpretation<TOutput> | NotUnderstoodChannelInterpretation;

/** The only way to build an interpretation. */
export const ChannelInterpretation = {
  /** The reply was read as `output`: validated like an answer given to `app.resume`. */
  understood<TOutput>(output: TOutput): UnderstoodChannelInterpretation<TOutput> {
    const built = { kind: ReplyInterpretationKind.Understood, output } as const;
    return Object.freeze(built) as UnderstoodChannelInterpretation<TOutput>;
  },
  /** The reply was not understood: `app.resume` throws `UninterpretableReplyError` with `reason`. */
  notUnderstood(reason: string): NotUnderstoodChannelInterpretation {
    const built = { kind: ReplyInterpretationKind.NotUnderstood, reason } as const;
    return Object.freeze(built) as NotUnderstoodChannelInterpretation;
  },
} as const;

/** What a code interpreter's `interpret` takes and gives, for a class without `implements`. */
export interface ChannelInterpreterHandler<TSelf> {
  readonly interpret: (
    input: ChannelInterpreterInput<TSelf>,
  ) => ChannelInterpretation<OutputOf<TSelf>> | Promise<ChannelInterpretation<OutputOf<TSelf>>>;
}

/** What `interpret` reads: the pause's question and the reply (`InputOf<Self>`). */
export type ChannelInterpreterInput<TSelf> = InputOf<TSelf>;

/** `@ChannelInterpreter({ model, prompt })`: one answer tool on a chat model. */
export interface ModelChannelInterpreterOptions {
  /** Kebab-case; the class name in kebab-case when left out. */
  readonly name?: string;
  readonly description?: string;
  /** A chat model (one answer tool); a decision model only for an approval. */
  readonly model: string;
  /** How to read a reply; static — the question and the reply come in the input message. */
  readonly prompt?: PromptValue;
  readonly promptUrls?: readonly string[];
  /** Static `{{key}}` values of this prompt, over the workflow's and the application's. */
  readonly promptVariables?: PromptVariables;
  readonly deps?: never;
}

/** `@ChannelInterpreter({ deps })` on a class with `interpret(input)`. */
export interface CodeChannelInterpreterOptions<TDeps extends readonly Token[] = readonly Token[]> {
  readonly name?: string;
  readonly description?: string;
  /** Constructor dependencies, in order; compiler-checked. */
  readonly deps?: TDeps;
  readonly model?: never;
  readonly prompt?: never;
  readonly promptUrls?: never;
  readonly promptVariables?: never;
}

/** `@ChannelInterpreter` options: a model's or a code one's. */
export type ChannelInterpreterOptions =
  ModelChannelInterpreterOptions | CodeChannelInterpreterOptions;

/** The decorator of an interpreter; a code interpreter's constructor takes its `deps`. */
export type ChannelInterpreterDecorator<TDeps extends readonly Token[]> = <
  TClass extends new (...args: ResolvedAll<TDeps>) => object,
>(
  value: TClass,
) => TClass;

/** An interpreter its chat model decides. */
export function ChannelInterpreter(
  options: ModelChannelInterpreterOptions,
): ChannelInterpreterDecorator<[]>;
/** An interpreter its class decides: `interpret(input)`, `deps` in its constructor. */
export function ChannelInterpreter<const TDeps extends readonly Token[] = []>(
  options?: CodeChannelInterpreterOptions<TDeps>,
): ChannelInterpreterDecorator<TDeps>;
export function ChannelInterpreter(
  options: ChannelInterpreterOptions = {},
): <TClass extends Class>(value: TClass) => TClass {
  const source = callerFile();
  return <TClass extends Class>(value: TClass): TClass => {
    const name = resolvedName(options.name, value);
    // a model one names its `model`; a class with `interpret` decides by code
    const isModel = options.model !== undefined;
    const named = isModel
      ? { ...options, name, decidedBy: DecidedBy.Model as const, model: options.model }
      : { ...options, name, decidedBy: DecidedBy.Code as const };
    const declaration = {
      options: named,
      isChannelInterpreter: true,
    } as ReplyInterpreterDeclaration;
    recordInterpreter(value, source === undefined ? declaration : { ...declaration, source });
    return value;
  };
}
