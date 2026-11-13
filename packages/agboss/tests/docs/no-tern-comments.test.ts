/**
 * #906 D3: "Tern" was a misspelling of "turn" (G8). The API reports carry no doc comments, so
 * `no-tern-names.test.ts` cannot see the shipped prose: every comment of the sources — the JSDoc a
 * `.d.ts` ships, and the `//` lines beside it — says "turn". Only the documented deprecated
 * aliases (`public/turn-deprecated.ts`) and the read of a paused run stored by 0.1.0 under its old
 * name `ternId` (the paused-run readers) may name it.
 */
import { globSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** Where the old name is kept on purpose: the five deprecated aliases, the 0.1.0 paused-run read. */
const DOCUMENTED = new Set([
  "packages/agboss/src/public/turn-deprecated.ts",
  "packages/agboss/src/app/paused-runs.ts",
  "packages/agboss/src/infrastructure/stored-run.ts",
]);

/** `Tern`, `Terns`, `ternId`, `tern`: not `pattern`, `external`, `internal`, `alternative`, … */
const OLD_NAME = /(?<![A-Za-z])ternId|(?<![A-Za-z])[Tt]erns?(?![a-z])/g;

const sources = globSync("packages/*/src/**/*.ts", { cwd: repo }).sort();

/** Every comment of a source file: its text and the line it starts on. */
function commentsOf(file: string): readonly { readonly text: string; readonly line: number }[] {
  const text = readFileSync(resolve(repo, file), "utf8");
  // only a file that names it anywhere is parsed: the walk of ~1,500 files stays fast
  if (!new RegExp(OLD_NAME).test(text)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const seen = new Set<number>();
  const found: { text: string; line: number }[] = [];
  const take = (ranges: readonly ts.CommentRange[] | undefined): void => {
    for (const range of ranges ?? []) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      found.push({
        text: text.slice(range.pos, range.end),
        line: source.getLineAndCharacterOfPosition(range.pos).line + 1,
      });
    }
  };
  const visit = (node: ts.Node): void => {
    take(ts.getLeadingCommentRanges(text, node.getFullStart()));
    take(ts.getTrailingCommentRanges(text, node.getEnd()));
    ts.forEachChild(node, visit);
  };
  visit(source);
  take(ts.getLeadingCommentRanges(text, source.endOfFileToken.getFullStart()));
  return found;
}

describe("#906 D3: the sources' comments say Turn", { timeout: 60_000 }, () => {
  it("walks the sources of every package", () => {
    expect(sources.length).toBeGreaterThan(500);
    expect(sources).toContain("packages/agboss/src/turns/types.ts");
    expect(DOCUMENTED.size).toBe(3);
    for (const file of DOCUMENTED) expect(sources).toContain(file);
  });

  it("no comment names a Tern outside the documented deprecated names", () => {
    const found = sources
      .filter((file) => !DOCUMENTED.has(file))
      .flatMap((file) =>
        commentsOf(file)
          .filter((comment) => new RegExp(OLD_NAME).test(comment.text))
          .map((comment) => `${file}:${String(comment.line)}`),
      );

    expect(found).toEqual([]);
  });

  it("the check sees a planted old name, and leaves the words that only contain it", () => {
    expect("/** Terns of a thread */".match(OLD_NAME)).toEqual(["Terns"]);
    expect("right before `ternId`".match(OLD_NAME)).toEqual(["ternId"]);
    expect(
      "a pattern, an external, an internal, an alternative, determine".match(OLD_NAME),
    ).toBeNull();
  });
});
