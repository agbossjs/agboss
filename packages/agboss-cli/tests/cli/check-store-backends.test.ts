/**
 * #526 acceptance (M2 automated, and the opt-out under `--strict`) — `agboss check` on a project's
 * stores: a fenced-effect store of another backend than the application's leases is a problem
 * naming both classes and both backends, exit 3; a store that opts out of the atomic lease check
 * passes with `[application.lease-check-not-atomic]` printed, and fails under `--strict`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agboss, envelope, fixture } from "./agboss.js";

const MISMATCH = fixture("cli/store-backend-mismatch.application.ts");
const OPTED_OUT = fixture("cli/opted-out-store.application.ts");
const CWD = mkdtempSync(join(tmpdir(), "agboss-check-backends-"));

interface Problem {
  readonly file: string;
  readonly code: string;
  readonly message: string;
}

const problemsOf = (call: Awaited<ReturnType<typeof agboss>>): readonly Problem[] =>
  (envelope(call).result as { readonly problems: readonly Problem[] }).problems;

const NOT_ATOMIC =
  "OptedOutEffects declares LeaseCheck.WithoutDoubleChargeProtection: it checks the lease outside its write's transaction, so a holder whose lease was taken over can still write — no protection against a double charge or a second owner's write; it passes no fencing case of storeConformance and must never back payments (Wiki → Your-own-store#an-opted-out-store-and-storeconformance-543)";

describe("#526 M2: agboss check on SqliteFencedEffectRepository without SqliteExecutionLeaseRepository", () => {
  it("one [application.store-backend-mismatch] naming both stores and both backends, exit 3", async () => {
    const printed = await agboss(["check", "--application", MISMATCH], CWD);
    const json = await agboss(["check", "--application", MISMATCH, "--json"], CWD);

    expect(printed.code).toBe(3);
    expect(printed.stdout).toContain(
      `${MISMATCH} application.store-backend-mismatch SqliteFencedEffectRepository (backend "sqlite") checks its leases in its own transaction, but the application's leases are in InMemoryExecutionLeaseRepository (backend "in-memory")`,
    );
    expect(json.code).toBe(3);
    expect(
      problemsOf(json).filter((found) => found.code.startsWith("application.store-backend")),
    ).toEqual([
      expect.objectContaining({ file: MISMATCH, code: "application.store-backend-mismatch" }),
    ]);
  });
});

describe("#526 AC1: agboss check on a store that opts out of the atomic lease check", () => {
  it("passes with the warning printed (exit 0); under --strict the warning is a problem (exit 3)", async () => {
    const warned = await agboss(["check", "--application", OPTED_OUT], CWD);
    const strict = await agboss(["check", "--strict", "--application", OPTED_OUT, "--json"], CWD);

    expect(warned.code).toBe(0);
    expect(warned.stdout).toContain(
      `warning: ${OPTED_OUT} application.lease-check-not-atomic ${NOT_ATOMIC}\n`,
    );
    expect(strict.code).toBe(3);
    expect(problemsOf(strict)).toContainEqual({
      file: OPTED_OUT,
      code: "application.lease-check-not-atomic",
      message: NOT_ATOMIC,
    });
  });
});
