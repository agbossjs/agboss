import type { Milliseconds } from "../units/index.js";
import { FlowSyntaxError } from "./flow-syntax-error.js";

const isDuration = (value: unknown): value is Milliseconds => typeof value === "number";

/**
 * The `expiresIn` of a question step's options: `{}` when absent. A number out of range stays as
 * given — assembly refuses it (`[channel.expires-in-invalid]`, with the step's name); anything that
 * is no options object or no number is refused here (untyped code).
 */
export function expiresInOptionOf(
  options: unknown,
  call: string,
): { readonly expiresIn?: Milliseconds } {
  if (options === undefined) return {};
  if (typeof options !== "object" || options === null)
    throw new FlowSyntaxError({ message: `${call} takes an options object` });
  const expiresIn: unknown = Reflect.get(options, "expiresIn");
  if (expiresIn === undefined) return {};
  if (!isDuration(expiresIn))
    throw new FlowSyntaxError({ message: `${call}: expiresIn is a duration, like hours(4)` });
  return { expiresIn };
}
