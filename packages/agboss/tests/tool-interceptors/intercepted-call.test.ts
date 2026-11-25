/**
 * #1295 — one call through its interceptors: `@BeforeTool` / `@AfterTool` methods and the
 * catch-alls in order, `allow({ input })` rewriting the arguments (validated again), the context
 * the catch-alls read (`agent`, `callId`, `ToolCall.typeOf`).
 */
import { describe, expect, it } from "vitest";
import {
  AfterTool,
  BeforeTool,
  Tool,
  ToolCall,
  ToolCallDecision,
  ToolInterceptor,
  type ToolCallContext,
} from "../../src/index.js";
import { Text } from "../../src/dto/index.js";
import { toolOf } from "../../src/components/runtime.js";
import { interceptedCall } from "../../src/graph/agent-loop/tool-interception.js";
import { methodsOf } from "../../src/tool-interceptors/assembly.js";
import type { RuntimeToolInterceptor } from "../../src/tool-interceptors/runtime.js";
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
    return { status: `status of ${orderId} | internal note` };
  }
}

const seen: string[] = [];

@ToolInterceptor({ name: "desk-tool-interceptor", description: "d" })
class DeskInterceptor {
  beforeAnyTool(call: ToolCallContext): ToolCallDecision {
    seen.push(
      `any:${call.tool.name}:${call.agent.name}:${call.callId}:${ToolCall.typeOf(call).name}`,
    );
    return ToolCallDecision.allow();
  }

  @BeforeTool(OrderStatusTool)
  normalise({ orderId }: Query): ToolCallDecision<Query> {
    seen.push(`before:${orderId}`);
    return orderId.startsWith("A-")
      ? ToolCallDecision.reply(`${orderId} is archived`)
      : ToolCallDecision.allow({ input: { orderId: orderId.trim() } });
  }

  @AfterTool(OrderStatusTool)
  strip({ status }: Status, { orderId }: Query): Status {
    seen.push(`after:${orderId}`);
    return { status: status.split("|")[0]?.trim() ?? status };
  }

  afterAnyTool(call: ToolCallContext & { readonly output: unknown }): unknown {
    seen.push("after-any");
    return call.output;
  }
}

const chainOf = (type: Class, instance: object): RuntimeToolInterceptor[] => [
  {
    name: "desk-tool-interceptor",
    instance,
    toolType: OrderStatusTool,
    beforeMethod: methodsOf(type).before.get(OrderStatusTool),
    afterMethod: methodsOf(type).after.get(OrderStatusTool),
  },
];

const callWith = async (input: unknown, chain: RuntimeToolInterceptor[]) => {
  const tool = toolOf(new OrderStatusTool());
  const args: unknown[] = [];
  const result = await interceptedCall(
    chain,
    tool,
    input,
    async (given) => {
      args.push(given);
      return tool.invoke(given);
    },
    () => undefined,
    { agent: "desk-agent", callId: "call-1" },
  );
  return { result, args };
};

describe("#1295: a call through @BeforeTool / @AfterTool and the catch-alls", () => {
  it("any first, then the tool's method; allow({ input }) feeds the tool; after: its method, then any", async () => {
    seen.length = 0;

    const { result, args } = await callWith(
      { orderId: " 7 " },
      chainOf(DeskInterceptor, new DeskInterceptor()),
    );

    expect(args).toEqual([{ orderId: "7" }]);
    expect(result).toEqual({
      kind: "ran",
      output: { kind: "ok", value: { status: "status of 7" } },
    });
    expect(seen).toEqual([
      "any:order-status:desk-agent:call-1:OrderStatusTool",
      "before: 7 ",
      "after:7",
      "after-any",
    ]);
  });

  it("reply() ends the chain before the tool runs", async () => {
    seen.length = 0;

    const { result, args } = await callWith(
      { orderId: "A-9" },
      chainOf(DeskInterceptor, new DeskInterceptor()),
    );

    expect(result).toEqual({ kind: "replied", message: "A-9 is archived" });
    expect(args).toEqual([]);
  });

  it("invalid arguments skip the method taking the input, the tool answers its own error", async () => {
    seen.length = 0;

    const { result } = await callWith(
      { wrong: 1 },
      chainOf(DeskInterceptor, new DeskInterceptor()),
    );

    expect(seen).toEqual(["any:order-status:desk-agent:call-1:OrderStatusTool"]);
    expect(result).toMatchObject({ kind: "ran", output: { kind: "error" } });
  });

  it("a rewritten input the tool does not take stops the call, the interceptor named", async () => {
    @ToolInterceptor({ name: "bad-rewrite-tool-interceptor", description: "d" })
    class BadRewrite {
      @BeforeTool(OrderStatusTool)
      rewrite(): ToolCallDecision<Query> {
        return ToolCallDecision.allow({ input: { orderId: 5 } as never });
      }
    }

    const { result, args } = await callWith(
      { orderId: "7" },
      chainOf(BadRewrite, new BadRewrite()),
    );

    expect(args).toEqual([]);
    expect(result).toMatchObject({
      kind: "stopped",
      stop: { kind: "failed", interceptor: "desk-tool-interceptor" },
    });
  });
});

describe("#1295: hooks are inherited by a subclass", () => {
  @ToolInterceptor({ name: "guard-tool-interceptor", description: "d" })
  class Guard {
    @BeforeTool(OrderStatusTool)
    authorise(): ToolCallDecision {
      return ToolCallDecision.block("not authorised");
    }
  }

  const blocked = { kind: "stopped", stop: { kind: "blocked", reason: "not authorised" } };

  it("a plain subclass keeps the parent's blocking @BeforeTool", async () => {
    @ToolInterceptor({ name: "child-tool-interceptor", description: "d" })
    class Child extends Guard {}

    const { result, args } = await callWith({ orderId: "7" }, chainOf(Child, new Child()));

    expect(result).toMatchObject(blocked);
    expect(args).toEqual([]);
  });

  it("a subclass that adds one hook keeps the parent's others", async () => {
    @ToolInterceptor({ name: "more-tool-interceptor", description: "d" })
    class More extends Guard {
      @AfterTool(OrderStatusTool)
      strip(output: Status): Status {
        return output;
      }
    }

    expect(methodsOf(More).before.get(OrderStatusTool)).toBe("authorise");
    expect(methodsOf(More).after.get(OrderStatusTool)).toBe("strip");
    const { result } = await callWith({ orderId: "7" }, chainOf(More, new More()));
    expect(result).toMatchObject(blocked);
  });

  it("a subclass hook on the same method replaces the parent's", async () => {
    @ToolInterceptor({ name: "override-tool-interceptor", description: "d" })
    class Override extends Guard {
      @BeforeTool(OrderStatusTool)
      override authorise(): ToolCallDecision {
        return ToolCallDecision.allow();
      }
    }

    const { result } = await callWith({ orderId: "7" }, chainOf(Override, new Override()));

    expect(result).toMatchObject({ kind: "ran" });
  });
});
