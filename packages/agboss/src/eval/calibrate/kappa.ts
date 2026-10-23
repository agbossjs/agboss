/**
 * Cohen's κ of two raters on one yes / no question (#396 S2 Q8): the agreement they reached beyond
 * what their own pass rates would give by chance, `(observed − chance) / (1 − chance)`. Undefined
 * without a pair, and when chance agreement is 1 — both raters gave one and the same verdict only,
 * so agreement says nothing.
 */

/** One run both rated: the first rater's verdict, then the second's. */
export type RatedPair = readonly [boolean, boolean];

/** The share of pairs on which the raters agree. */
export function observedAgreement(pairs: readonly RatedPair[]): number {
  if (pairs.length === 0) return 0;
  return pairs.filter(([first, second]) => first === second).length / pairs.length;
}

/** Cohen's κ, or undefined when it is not defined. */
export function cohenKappa(pairs: readonly RatedPair[]): number | undefined {
  const n = pairs.length;
  if (n === 0) return undefined;
  const firstPassed = pairs.filter(([first]) => first).length / n;
  const secondPassed = pairs.filter(([, second]) => second).length / n;
  const chance = firstPassed * secondPassed + (1 - firstPassed) * (1 - secondPassed);
  if (chance === 1) return undefined;
  return (observedAgreement(pairs) - chance) / (1 - chance);
}
