/**
 * #1295a security fix — the tool interceptors fail closed: a tool that resolves to no class still
 * meets the catch-all hooks, tool types are per agent, and a subclass hook never loses a parent's
 * target silently.
 */
import { describe, expect, it } from "vitest";
import { BeforeTool, Tool, ToolCallDecision, ToolInterceptor } from "../../src/index.js";
import { Text } from "../../src/dto/index.js";
import { toolOf } from "../../src/components/runtime.js";
import type { AgentMeta } from "../../src/components/meta-types.js";
import { interceptedCall } from "../../src/graph/agent-loop/tool-interception.js";
import {
  methodsOf,
  toolInterceptorPartsOf,
  toolInterceptorViolations,
} from "../../src/tool-interceptors/assembly.js";
import { toolInterceptorMetaOf } from "../../src/tool-interceptors/decorator.js";
import { toolInterceptorRuntimeOf } from "../../src/tool-interceptors/runtime.js";
import type { Class } from "../../src/components/injection.js";

class Query {
  @Text({ prompt: "the order" })
  orderId!: string;
}

class Status {
  @Text({ prompt: "the status" })
  status!: string;
}

@Tool({ name: "order-status", description: "d", input: Query, output: Status })
class OrderStatusTool {
  execute({ orderId }: Query): Status {
    return { status: orderId };
  }
}

@Tool({ name: "order-cancel", description: "d", input: Query, output: Status })
class OrderCancelTool {
  execute({ orderId }: Query): Status {
    return { status: orderId };
  }
}

class NotATool {
  run(): string {
    return "not a tool";
  }
}

const agentOf = (name: string, tools: Class[]): AgentMeta => ({ name, tools }) as never;

const none = { application: [], workflow: [], workflowName: "w" };

const run = async (chain: Parameters<typeof interceptedCall>[0]) => {
  const tool = toolOf(new OrderStatusTool());
  let ran = false;
  const result = await interceptedCall(
    chain,
    tool,
    { orderId: "1" },
    async (input) => {
      ran = true;
      return tool.invoke(input);
    },
    () => undefined,
    { agent: "desk-agent", callId: "c" },
  );
  return { result, ran };
};

describe("#1295a: an unresolvable tool is never unintercepted", () => {
  @ToolInterceptor({ name: "deny-tool-interceptor", description: "d" })
  class Deny {
    beforeAnyTool(): ToolCallDecision {
      return ToolCallDecision.block("denied");
    }
  }

  it("a tool no agent lists still meets a blocking beforeAnyTool", async () => {
    const assembled = toolInterceptorPartsOf({ ...none, application: [Deny] }, [
      agentOf("desk-agent", [OrderStatusTool]),
    ]);
    const chain = toolInterceptorRuntimeOf(assembled, () => new Deny()).ofAgent("desk-agent")(
      "ghost-tool",
    );

    expect(chain).toHaveLength(1);
    const { result, ran } = await run(chain);
    expect(result).toMatchObject({ kind: "stopped", stop: { kind: "blocked", reason: "denied" } });
    expect(ran).toBe(false);
  });

  it("[tool-interceptor.unresolved-tool]: an agent with interceptors lists only tool classes", () => {
    expect(() =>
      toolInterceptorPartsOf({ ...none, application: [Deny] }, [agentOf("desk-agent", [NotATool])]),
    ).toThrow(/unresolved-tool/u);
  });
});

describe("#1295a: one agent never has two tools of one name", () => {
  @Tool({ name: "twin", description: "d", input: Query, output: Status })
  class TwinOne {
    execute(): Status {
      return { status: "1" };
    }
  }

  @Tool({ name: "twin", description: "d", input: Query, output: Status })
  class TwinTwo {
    execute(): Status {
      return { status: "2" };
    }
  }

  it("[tool-interceptor.duplicate-tool-name] instead of the last class overwriting the first", () => {
    @ToolInterceptor({ name: "any-tool-interceptor", description: "d" })
    class Any {
      beforeAnyTool(): ToolCallDecision {
        return ToolCallDecision.allow();
      }
    }

    expect(() =>
      toolInterceptorPartsOf({ ...none, application: [Any] }, [
        agentOf("desk-agent", [TwinOne, TwinTwo]),
      ]),
    ).toThrow(/duplicate-tool-name/u);
  });
});

describe("#1295a: tool types are per agent", () => {
  @Tool({ name: "same", description: "d", input: Query, output: Status })
  class SameA {
    execute(): Status {
      return { status: "a" };
    }
  }

  @Tool({ name: "same", description: "d", input: Query, output: Status })
  class SameB {
    execute(): Status {
      return { status: "b" };
    }
  }

  @ToolInterceptor({ name: "a-tool-interceptor", description: "d" })
  class GuardA {
    @BeforeTool(SameA)
    check(): ToolCallDecision {
      return ToolCallDecision.allow();
    }
  }

  @ToolInterceptor({ name: "b-tool-interceptor", description: "d" })
  class GuardB {
    @BeforeTool(SameB)
    check(): ToolCallDecision {
      return ToolCallDecision.allow();
    }
  }

  it("two agents with a same-named tool each get their own class's hooks", () => {
    const assembled = toolInterceptorPartsOf({ ...none, application: [GuardA, GuardB] }, [
      agentOf("agent-a", [SameA]),
      agentOf("agent-b", [SameB]),
    ]);
    const runtime = toolInterceptorRuntimeOf(assembled, (cls) => new (cls as new () => object)());

    const [guardA, guardB] = runtime.ofAgent("agent-a")("same");
    expect(guardA?.toolType).toBe(SameA);
    expect(guardA?.beforeMethod).toBe("check");
    expect(guardB?.beforeMethod).toBeUndefined();
    const forB = runtime.ofAgent("agent-b")("same");
    expect(forB[0]?.toolType).toBe(SameB);
    expect(forB[0]?.beforeMethod).toBeUndefined();
    expect(forB[1]?.beforeMethod).toBe("check");
  });
});

describe("#1295a: a subclass hook never loses a parent's target", () => {
  @ToolInterceptor({ name: "guard-tool-interceptor", description: "d" })
  class Guard {
    @BeforeTool(OrderStatusTool, OrderCancelTool)
    authorise(): ToolCallDecision {
      return ToolCallDecision.block("not authorised");
    }
  }

  @ToolInterceptor({ name: "narrow-tool-interceptor", description: "d" })
  class Narrow extends Guard {
    @BeforeTool(OrderStatusTool)
    override authorise(): ToolCallDecision {
      return ToolCallDecision.allow();
    }
  }

  it("the merge keeps the parent's targets", () => {
    expect(methodsOf(Narrow).before.get(OrderCancelTool)).toBe("authorise");
    expect(methodsOf(Narrow).before.get(OrderStatusTool)).toBe("authorise");
  });

  it("[tool-interceptor.override-drops-target] refuses the override", () => {
    const meta = toolInterceptorMetaOf(Narrow);
    if (meta === undefined) throw new Error("no meta");
    expect(toolInterceptorViolations(Narrow, meta).map((item) => item.code)).toEqual([
      "tool-interceptor.override-drops-target",
    ]);
  });
});
