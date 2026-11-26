/** #1324: the runner of an external task refuses a node of another kind, naming an "external task". */
import { describe, expect, it } from "vitest";
import { ComponentKind } from "../../../src/flow/runtime/records.js";
import { questionRunner } from "../../../src/flow/runtime/runners/question.js";

describe("questionRunner", () => {
  it("refuses an agent node: it is not an external task", () => {
    const node = { id: "clerk-agent", declaration: { kind: ComponentKind.Agent } };
    expect(() => questionRunner(node as never, {} as never, {} as never)).toThrow(
      "clerk-agent is not an external task",
    );
  });
});
