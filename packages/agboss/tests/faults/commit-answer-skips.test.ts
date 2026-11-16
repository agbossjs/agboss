import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FaultScenarioSkippedError, runFaultScenario } from "../../src/testing/faults/scenario.js";
import { s23cCommitAnswerProtocolError } from "../../src/testing/faults/scenarios/s23-commit-answer-reset.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

/**
 * #1017 — scenario 23c cannot run on a store set whose commit is retried (MongoDB's), nor on one
 * with no TCP link to put an answer on (SQLite, in-memory): it is skipped with its reason, never
 * passed. The core's own set has no link; the resolving set also declares `resolvesCommitByRetry`.
 */
const skipOf = async (storesModule?: string): Promise<unknown> =>
  runFaultScenario(s23cCommitAnswerProtocolError, sqliteFaultTarget(storesModule)).then(
    () => undefined,
    (error: unknown) => error,
  );

describe("#1017: scenario 23c skips where its fault cannot be delivered", () => {
  it("a store set without a TCP link", async () => {
    const skipped = await skipOf();

    expect(skipped).toBeInstanceOf(FaultScenarioSkippedError);
    expect((skipped as Error).message).toBe(
      "the store set has no TCP link: a protocol error cannot be put in place of its COMMIT's answer",
    );
  }, 60_000);

  it("a store set whose commit is retried", async () => {
    const skipped = await skipOf(
      fileURLToPath(new URL("./resolving.fault-stores.ts", import.meta.url)),
    );

    expect(skipped).toBeInstanceOf(FaultScenarioSkippedError);
    expect((skipped as Error).message).toMatch(/^the store set's commit is retried/u);
  }, 60_000);
});
