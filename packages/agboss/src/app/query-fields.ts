import { type DtoIssue, invalidDto } from "../dto/errors.js";

/**
 * A field a listing's query does not have (a retired `after`, a `role`, a typo) is refused, never
 * ignored: a page loop would otherwise go on for ever on page 1 (#1307e, 21.3). One rule for
 * `listPauses`, `listExecutions` and the other listings.
 */

/** The issues of the fields of `query` that are not in `known`. */
export const unknownFieldIssues = (
  query: object,
  known: ReadonlySet<string>,
): readonly DtoIssue[] =>
  Object.keys(query)
    .filter((key) => !known.has(key))
    .map((key) => ({ path: key, reason: `not a field of this query` }));

/** Throws `validation.dto-invalid` of `dto` when `query` has a field outside `known`. */
export function refuseUnknownFields(dto: string, query: unknown, known: ReadonlySet<string>): void {
  if (typeof query !== "object" || query === null) return;
  const issues = unknownFieldIssues(query, known);
  if (issues.length > 0) throw invalidDto({ dto, issues });
}
