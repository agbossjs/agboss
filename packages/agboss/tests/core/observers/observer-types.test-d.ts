import { describe, expectTypeOf, it } from "vitest";
import type {
  AgentRetryEvent,
  AgentRetryReason,
  ExecutionEndEvent,
  ExecutionObserver,
  JudgeEndEvent,
  JudgeStartEvent,
  ToolEndEvent,
  ToolStartEvent,
} from "../../../src/index.js";

describe("types of the observer events", () => {
  it("the removed single-hook interfaces are gone, the events are flat", () => {
    expectTypeOf<ToolStartEvent["tool"]>().toEqualTypeOf<string>();
    expectTypeOf<ToolStartEvent["agent"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ToolStartEvent["input"]>().toEqualTypeOf<Readonly<Record<string, unknown>>>();
    expectTypeOf<ToolEndEvent["output"]>().toEqualTypeOf<string>();
    expectTypeOf<JudgeStartEvent["judge"]>().toEqualTypeOf<string>();
    expectTypeOf<JudgeEndEvent["agent"]>().toEqualTypeOf<string>();
    expectTypeOf<ExecutionEndEvent["output"]>().toEqualTypeOf<unknown>();
    expectTypeOf<AgentRetryEvent["reason"]>().toEqualTypeOf<AgentRetryReason>();
    expectTypeOf<ExecutionObserver["onAgentRetry"]>().toEqualTypeOf<
      ((event: AgentRetryEvent) => void | Promise<void>) | undefined
    >();
    expectTypeOf<ToolStartEvent>().not.toHaveProperty("toolName");
    expectTypeOf<ToolEndEvent>().not.toHaveProperty("update");
    expectTypeOf<ToolStartEvent>().not.toHaveProperty("arguments");
  });
});
