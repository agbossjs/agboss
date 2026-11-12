/**
 * #906 AC3 (completing #890 AC4): "Tern" was a misspelling of "turn". No API report names it — not a
 * type, a member, a parameter nor a source path — but the five deprecated aliases #890 kept for one
 * minor (`Tern`, `NewTern`, `TernOutcome`, `TernStatus`, `TernStep`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const API = join(import.meta.dirname, "../../api");
const ALIASES = new Set(["Tern", "NewTern", "TernOutcome", "TernStatus", "TernStep"]);
/** Words that only contain "tern" (pattern, internal, alternative, …). */
const OTHER_WORDS =
  /pattern|interpreter|intern|extern|altern|concern|govern|lantern|stern|modern|cistern|eternal|maternal|paternal|fraternal|ternary/i;

const ternWordsOf = (text: string): string[] =>
  (text.match(/[A-Za-z0-9_]*tern[A-Za-z0-9_]*/gi) ?? []).filter((word) => !OTHER_WORDS.test(word));

describe("#906 AC3: no Tern in any API report but the deprecated aliases", () => {
  const reports = readdirSync(API).filter((file) => file.endsWith(".api.md"));

  it("AC3: the reports are there", () => {
    expect(reports.length).toBeGreaterThan(15);
  });

  it.each(reports)("AC3: %s names no Tern but the five deprecated aliases", (report) => {
    const words = ternWordsOf(readFileSync(join(API, report), "utf8"));

    expect(words.filter((word) => !ALIASES.has(word))).toEqual([]);
  });

  it("AC3: the contract's names are Turn's", () => {
    const stores = readFileSync(join(API, "agboss-stores.api.md"), "utf8");

    expect(stores).toContain("abstract lastTurns(");
    expect(stores).toContain("readonly fromTurnId: string;");
    expect(stores).toContain("readonly toTurnId: string;");
    expect(readFileSync(join(API, "agboss.api.md"), "utf8")).toContain(
      "readonly turns: TurnRecords;",
    );
  });
});
