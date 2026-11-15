import type { Milliseconds } from "../../src/units/index.js";

/** A plain number of milliseconds as the typed duration a calendar request carries. */
export const milliseconds = (amount: number): Milliseconds => amount as Milliseconds;
