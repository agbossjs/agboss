// Folders that left the repository (#489): a doc that says how the system works now must not point
// at one — the link would lead nowhere. Only the pages that record history keep their mentions:
// the ADRs (`ADR-0011-…`) and the Changelog. Checked on every line, fenced blocks included (a
// `cd examples/job-scout` there points at the folder as much as a link does).
import { basename } from "node:path";

/** Each folder that left the repository and where it went. */
export const REMOVED_PATHS = [
  {
    path: "examples/job-scout",
    movedTo: "https://github.com/agbossjs/agboss-examples/tree/main/08-job-scout",
  },
];

/** A page that records history: an ADR or the Changelog (in the repo `CHANGELOG.md`). */
export function isHistory(doc) {
  const name = basename(doc, ".md");
  return /^ADR-\d+/.test(name) || /^changelog$/i.test(name);
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// the folder itself: not the tail of another name (`agboss-examples/job-scout`), not a longer one,
// not a file of that name (the website's `src/content/docs/examples/job-scout.md`)
const PATTERNS = REMOVED_PATHS.map(({ path, movedTo }) => ({
  path,
  movedTo,
  pattern: new RegExp(`(?<![\\w.-])${escape(path)}(?![\\w-]|\\.\\w)`),
}));

/** Mentions of a removed folder in one doc, one per line and folder, as `doc:line: …`. */
export function removedPathProblems(doc, markdown) {
  if (isHistory(doc)) return [];
  const problems = [];
  markdown.split("\n").forEach((text, index) => {
    for (const { path, movedTo, pattern } of PATTERNS)
      if (pattern.test(text))
        problems.push(
          `${doc}:${String(index + 1)}: ${path} left the repository — link ${movedTo} instead`,
        );
  });
  return problems;
}
