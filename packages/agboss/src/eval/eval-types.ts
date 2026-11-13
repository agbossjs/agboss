/**
 * The types an eval case computes with (#895, @beta: type machinery, not a contract): `EvalCase`
 * names them in a type error; no case of yours writes them, so their names may change in any
 * release. Types only: re-exported as the namespace `EvalTypes`.
 */
export { type EvalContextsOf, type EvalTurnsOf } from "./suite/cases.js";
