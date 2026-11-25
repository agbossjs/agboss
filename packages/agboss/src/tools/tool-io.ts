/**
 * The types a tool class gives its input and its output (#1294, #1295): read from its `execute`.
 * Pure types, shared by the tool interceptors and the testing runners.
 */

/** A tool's input as its `execute` takes it: a plain object of its input DTO. */
export type ToolInputOf<TTool> = TTool extends { execute(input: infer TInput): unknown }
  ? TInput
  : never;

/** What a tool's `execute` gives (a promise of it, awaited): its output DTO. */
export type ToolOutputOf<TTool> = TTool extends { execute(input: never): infer TReturn }
  ? Awaited<TReturn>
  : never;

/** `A | B` as `A & B`: what one value must satisfy to be valid for every member. */
export type UnionToIntersection<TUnion> = (
  TUnion extends unknown ? (value: TUnion) => void : never
) extends (value: infer TIntersection) => void
  ? TIntersection
  : never;
