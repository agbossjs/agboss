/**
 * A hint after an exact lookup failed (#268): the known name closest to what was typed. Only a
 * message — nothing is ever chosen or run under a suggested name.
 */

/** The edit distance between two names (insertions, deletions, substitutions); names are kebab-case. */
function distance(first: string, second: string): number {
  let previous = Array.from({ length: second.length + 1 }, (_, index) => index);
  for (let row = 0; row < first.length; row++) {
    const current = [row + 1];
    for (let column = 0; column < second.length; column++) {
      const replaced = (previous[column] ?? 0) + (first[row] === second[column] ? 0 : 1);
      const inserted = (current[column] ?? 0) + 1;
      const deleted = (previous[column + 1] ?? 0) + 1;
      current.push(Math.min(replaced, inserted, deleted));
    }
    previous = current;
  }
  return previous[second.length] ?? 0;
}

/** How far a known name is from the typed one: a name that contains it (a missing suffix) is nearest. */
const farness = (typed: string, known: string): number =>
  known.includes(typed) ? known.length - typed.length : distance(typed, known) * 100;

/** The known name to suggest for `typed`, if one is close enough; the first of equals. */
export function closestName(typed: string, known: readonly string[]): string | undefined {
  const near = known
    .map((name) => ({ name, farness: farness(typed, name) }))
    .filter((candidate) => candidate.farness < Math.max(3, typed.length / 2) * 100)
    .sort((first, second) => first.farness - second.farness);
  return near[0]?.name;
}

/** ` Did you mean "screening-workflow-start"?` — empty when nothing is close. */
export function didYouMean(typed: string, known: readonly string[]): string {
  const closest = closestName(typed, known);
  return closest === undefined ? "" : ` Did you mean "${closest}"?`;
}
