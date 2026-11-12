/**
 * #934 AC3: a saved eval run artifact written by 0.1.0 names the person of a pause `responder`;
 * it reads as `answeredBy` (the new name), the old key kept as a deprecated alias.
 */
import { describe, expect, it } from "vitest";
import { ExecutionTraceSchema } from "../../src/eval/run/trace-schema.js";

const traceOf = (pause: Record<string, unknown>) => ({
  executionId: "e1",
  path: [],
  steps: [],
  handledErrors: [],
  pauses: [
    { nodeId: "refund-agent", role: "refund-approval-channel", resolution: "replied", ...pause },
  ],
  compensations: [],
  children: [
    {
      executionId: "c1",
      workflow: "w",
      status: "finished",
      launchedBy: "n",
      path: [],
      steps: [],
      handledErrors: [],
      pauses: [{ nodeId: "a", role: "r", resolution: "replied", ...pause }],
      compensations: [],
      children: [],
    },
  ],
});

describe("AC3: an eval run artifact with responder reads as answeredBy", () => {
  it("a 0.1.0 artifact: responder → answeredBy, the alias kept, at every depth", () => {
    const trace = ExecutionTraceSchema.parse(traceOf({ responder: "owner-1" }));
    expect(trace.pauses[0]).toMatchObject({ answeredBy: "owner-1", responder: "owner-1" });
    expect(trace.children[0]?.pauses[0]).toMatchObject({
      answeredBy: "owner-1",
      responder: "owner-1",
    });
  });

  it("a new artifact: answeredBy wins, responder filled as the alias", () => {
    const trace = ExecutionTraceSchema.parse(traceOf({ answeredBy: "owner-2" }));
    expect(trace.pauses[0]).toMatchObject({ answeredBy: "owner-2", responder: "owner-2" });
  });

  it("a pause nobody answered has neither", () => {
    const trace = ExecutionTraceSchema.parse(traceOf({}));
    expect(trace.pauses[0]).not.toHaveProperty("answeredBy");
    expect(trace.pauses[0]).not.toHaveProperty("responder");
  });
});
