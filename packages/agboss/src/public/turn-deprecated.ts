/**
 * The record types' names before #890 (API review G8): "Tern" was a misspelling of "turn". Kept one
 * minor release as deprecated aliases, re-exported by `export *` so that no module of the core
 * names them; removed in 0.2.
 */
import type { NewTurn, Turn, TurnOutcome, TurnStatus, TurnStep } from "../turns/index.js";

/** @deprecated Use {@link Turn} (#890); removed in 0.2. */
export type Tern = Turn;
/** @deprecated Use {@link NewTurn} (#890); removed in 0.2. */
export type NewTern = NewTurn;
/** @deprecated Use {@link TurnOutcome} (#890); removed in 0.2. */
export type TernOutcome = TurnOutcome;
/** @deprecated Use {@link TurnStatus} (#890); removed in 0.2. */
export type TernStatus = TurnStatus;
/** @deprecated Use {@link TurnStep} (#890); removed in 0.2. */
export type TernStep = TurnStep;
