/**
 * The types the DTO decorators and the wrappers compute with (#895, @beta: type machinery, not a
 * contract): `list(…)`, `oneOf(…)`, `@ListOf`, `@Optional` name them in a type error; no DTO of yours
 * writes them, so their names may change in any release. Types only: re-exported as the namespace
 * `DtoTypes`.
 */
export { type ListOfFactory } from "./decorators.js";
export { type PlainFieldContext } from "./types.js";
export {
  type ListElementShape,
  type OneOfVariants,
  type OptionalInnerShape,
  type PartialVariant,
  type Wrapper,
} from "../flow/dto-wrappers.js";
