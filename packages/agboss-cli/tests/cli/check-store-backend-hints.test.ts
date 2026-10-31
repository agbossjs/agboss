/**
 * #539 acceptance (M1 and M2 automated) — `agboss check` says what to fix: a fenced-effect store on
 * "postgres" without its lease store gets the hint naming a lease store on "postgres" and the
 * core's in-memory store in its place (exit 3); two fenced-effect stores are one
 * `[di.ambiguous-implementation]` naming both, with the SQLite one's own mismatch, in one run.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agboss, envelope, fixture } from "./agboss.js";

const HINT = fixture("cli/store-backend-hint.application.ts");
const TWO = fixture("cli/two-effect-stores.application.ts");
const CWD = mkdtempSync(join(tmpdir(), "agboss-check-hints-"));

interface Problem {
  readonly code: string;
  readonly message: string;
}

const problemsOf = (call: Awaited<ReturnType<typeof agboss>>): readonly Problem[] =>
  (envelope(call).result as { readonly problems: readonly Problem[] }).problems.filter(
    (found) => found.code.startsWith("application.store-backend") || found.code.startsWith("di."),
  );

describe("#539 M1: agboss check on a PostgreSQL fenced-effect store without its lease store", () => {
  it("prints the hint naming a lease store on postgres, or the in-memory store in its place; exit 3", async () => {
    const printed = await agboss(["check", "--application", HINT], CWD);

    expect(printed.code).toBe(3);
    expect(printed.stdout).toContain(
      'list it with a lease store declaring backend "postgres", or list a fenced-effect store declaring backend "in-memory" (InMemoryFencedEffectRepository) in its place',
    );
    expect(printed.stdout).not.toContain("SqliteExecutionLeaseRepository");
  });
});

describe("#539 M2: agboss check on two fenced-effect stores", () => {
  it("one ambiguity naming both, and the SQLite store's mismatch, in one run", async () => {
    const json = await agboss(["check", "--application", TWO, "--json"], CWD);

    expect(json.code).toBe(3);
    expect(problemsOf(json)).toEqual([
      expect.objectContaining({
        code: "di.ambiguous-implementation",
        message:
          '2 listed classes are fenced-effect stores (FencedEffectRepository): SqliteFencedEffectRepository (backend "sqlite"), InMemoryFencedEffectRepository (backend "in-memory") — list one',
      }),
      expect.objectContaining({
        code: "application.store-backend-mismatch",
        message: expect.stringContaining('SqliteFencedEffectRepository (backend "sqlite")'),
      }),
    ]);
  });
});
