import { TestSetupError } from "./errors.js";
import type { ScriptedCall, ScriptedTurn } from "./turns.js";

const plural = (count: number, word: string): string =>
  `${String(count)} ${word}${count === 1 ? "" : "s"}`;

/**
 * The turns of one script, taken by position: each model call takes the next one (with the waits
 * before it), then the `thenReturnAlways` turn. What was never taken is a leftover (#262 AC7).
 */
export class TurnQueue {
  readonly #turns: ScriptedTurn[] = [];
  #always: ScriptedCall["turn"] | undefined;
  #position = 0;
  #taken = 0;

  push(turns: readonly ScriptedTurn[]): void {
    this.#turns.push(...turns);
  }

  always(turn: ScriptedTurn): void {
    if (turn.kind === "wait") {
      throw new TestSetupError("thenReturnAlways(waitFor(…)): a wait is followed by its answer");
    }
    this.#always = turn;
  }

  get isScripted(): boolean {
    return this.#turns.length > 0 || this.#always !== undefined;
  }

  /** How many calls took a turn so far. */
  get taken(): number {
    return this.#taken;
  }

  /** The next call's turn and the time it waits first; `undefined` once the turns run out. */
  take(): ScriptedCall | undefined {
    let delay = 0;
    while (this.#position < this.#turns.length) {
      const turn = this.#turns[this.#position];
      this.#position += 1;
      if (turn === undefined) break;
      if (turn.kind === "wait") {
        delay += turn.delay;
        continue;
      }
      this.#taken += 1;
      return { turn, delay };
    }
    if (this.#always === undefined) return undefined;
    this.#taken += 1;
    return { turn: this.#always, delay };
  }

  /** Why the queue had nothing for a call: how many turns it had, which call asked. */
  exhausted(label: string): string {
    const scripted = this.#turns.filter((turn) => turn.kind !== "wait").length;
    const asked = `asked for #${String(this.#taken + 1)}`;
    return `script exhausted for ${label}: ${plural(scripted, "turn")} scripted, ${asked} — add turns or end with .thenReturnAlways(…)`;
  }

  /** The `thenReturn` turns no call took (a `thenReturnAlways` turn is never one). */
  get leftover(): number {
    return this.#turns.slice(this.#position).filter((turn) => turn.kind !== "wait").length;
  }

  /** Whether the queue expects to be used: it has `thenReturn` turns, not only an always turn. */
  get expectsUse(): boolean {
    return this.#turns.some((turn) => turn.kind !== "wait");
  }

  /** A leftover, as the test's failure says it; `undefined` when every turn was used. */
  leftoverText(label: string): string | undefined {
    const left = this.leftover;
    if (left === 0) return undefined;
    return `${label}: ${plural(left, "scripted turn")} never used`;
  }
}
