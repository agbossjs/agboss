/**
 * The types the DTO decorators and the wrappers compute with (#895, @beta: type machinery, not a
 * contract): `list(…)`, `oneOf(…)`, `@List`, `@Optional` name them in a type error; no DTO of yours
 * writes them, so their names may change in any release. Types only: re-exported as the namespace
 * `DtoTypes`.
 */
export {
  type EnumFactory,
  type ListFactory,
  type ListField,
  type OptionalListField,
} from "./decorators.js";
export { type PlainFieldContext } from "./types.js";
