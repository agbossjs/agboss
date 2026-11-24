import { usd } from "../../src/units/index.js";
/**
 * #1325a security: a `RecordedError` is an `AGBossError`, so every boundary that trusts "an AGBossError's
 * code is a framework code" must still say nothing of a recorded error whose original was a third-party
 * SDK's or a project's own — its code, name and message stay inside (`internal`, a fixed text).
 */
import { describe, expect, it } from "vitest";
import { errorRecordOf, INTERNAL_CODE, RecordedError } from "../../src/core/error-record.js";
import { guarded } from "../../src/mcp/mcp-service-helpers.js";
import { failedStatusOf, INTERNAL_FAILURE } from "../../src/a2a/tasks/task-status.js";
import { codeOfErrorRecordBoundary } from "./recorded-error-boundaries.helpers.js";
import { LimitError } from "../../src/index.js";

class StripeCardError extends Error {
  static readonly code = "card_declined_4242";
  override name = "StripeCardError";
}

const SECRET = "card 4242 4242 4242 4242 declined for jane@example.com";

const thirdParty = (): RecordedError =>
  new RecordedError(errorRecordOf(new StripeCardError(SECRET)));
const framework = (): RecordedError =>
  new RecordedError(
    errorRecordOf(
      new LimitError.Visits({ nodeId: "a", limit: 1, actual: 2, path: [], spentUsd: usd(0) }),
    ),
  );

const LEAKS = ["card_declined", "4242", "jane@example.com", "StripeCardError"];

describe("#1325a: a recorded third-party error is internal, a recorded framework error keeps its code", () => {
  it("its code is neutral, and the lineage tells whether it was a framework error", () => {
    expect(thirdParty().code).toBe(INTERNAL_CODE);
    expect(thirdParty().isFramework).toBe(false);
    expect(framework().code).toBe("limit.visits");
    expect(framework().isFramework).toBe(true);
  });

  it("the A2A task status (what the HTTP listener serves) is `internal` with no code, name or message", () => {
    const status = failedStatusOf(thirdParty());

    expect(JSON.stringify(status)).toContain(INTERNAL_FAILURE);
    for (const leak of LEAKS) expect(JSON.stringify(status), leak).not.toContain(leak);
    expect(JSON.stringify(failedStatusOf(framework()))).toContain("limit.visits");
  });

  it("failedStatusOf does not rest on the code rule alone: a recorded third-party error with a leaking code is still `internal`", () => {
    const leaking = thirdParty();
    Object.defineProperty(leaking, "code", { value: "card_declined_4242" });

    const status = failedStatusOf(leaking);

    expect(JSON.stringify(status)).toContain(INTERNAL_FAILURE);
    expect(JSON.stringify(status)).not.toContain("card_declined");
  });

  it("the MCP error result says nothing of it", async () => {
    const result = await guarded(async () => Promise.reject(thirdParty()));

    expect(result.isError).toBe(true);
    for (const leak of LEAKS) expect(JSON.stringify(result), leak).not.toContain(leak);
  });

  it("a duck-typed reader of `code` gets the neutral one", () => {
    expect(codeOfErrorRecordBoundary(thirdParty())).toBe(INTERNAL_CODE);
  });
});
