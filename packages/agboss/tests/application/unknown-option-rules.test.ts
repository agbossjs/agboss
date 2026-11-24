/**
 * #1313, #1318, #1324: `[decorator.unknown-option]` — a key a decorator does not take fails assembly, whether it
 * came behind a spread, an untyped variable or from JS. The message names the option and the decorator,
 * never the value. No shard mutates it (tests/docs/non-sharded-src.ts gives the reason).
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { Application, requireApplication } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { closestKey, unknownOptionViolations } from "../../src/application/unknown-option-rules.js";
import { APPLICATION_KEYS, WORKFLOW_KEYS } from "../../src/components/decorator-options.js";
import type { Class } from "../../src/components/injection.js";
import { optionKeys } from "../../src/components/option-keys.js";
import { Agent } from "../../src/flow/decorators/agent.js";
import { Workflow } from "../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../src/flow/decorators/workflow-start.js";
import {
  Action,
  Budget,
  EmptyEnvironment,
  Injectable,
  InputGuardrail,
  Memory,
  Tool,
  ToolInterceptor,
} from "../../src/index.js";
import { ItemDto } from "../flow/runtime/fixtures/fan-out.workflow.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import { onStart } from "../helpers/flow.js";

/** A value no message may carry. */
const SECRET = "sk-live-do-not-print";

const messagesOf = (...classes: Class[]): string[] =>
  unknownOptionViolations(classes).map((found) => found.message);

/** Options as a JS caller or a spread of an untyped variable gives them: the compiler sees nothing. */
const loose = (options: Record<string, unknown>): never => options as never;

describe("optionKeys", () => {
  it("holds the list equal to the keys of the options type", () => {
    interface Options {
      readonly a?: number;
      readonly b?: string;
    }
    optionKeys<Options>()(["a", "b"]);
    // @ts-expect-error — `b` is a key of the type and not on the list
    optionKeys<Options>()(["a"]);
    // @ts-expect-error — `c` is not a key of the type
    optionKeys<Options>()(["a", "b", "c"]);
    expectTypeOf(optionKeys<Options>()(["a", "b"]).keys).toEqualTypeOf<ReadonlySet<string>>();
    expect(optionKeys<Options>()(["a", "b"]).keys.size).toBe(2);
  });

  it("takes every key of every member of a union", () => {
    type Either = { readonly a?: 1 } | { readonly b?: 2 };
    expect(optionKeys<Either>()(["a", "b"]).keys.has("b")).toBe(true);
  });

  it("lists the keys of a decorator once: the application's and the workflow's", () => {
    expect(APPLICATION_KEYS.keys.has("executionLimits")).toBe(true);
    expect(APPLICATION_KEYS.moved.get("shutdownTimeout")).toBe("executionLimits");
    expect(WORKFLOW_KEYS.keys.has("maxSteps")).toBe(true);
  });
});

describe("closestKey", () => {
  it("finds a case-only difference and a near typo, and nothing far", () => {
    const allowed = ["guardrails", "piiPolicies", "toolInterceptors"];
    expect(closestKey("guardrail", allowed)).toBe("guardrails");
    expect(closestKey("PiiPolicies", allowed)).toBe("piiPolicies");
    expect(closestKey("toolInterceptor", allowed)).toBe("toolInterceptors");
    expect(closestKey("budget", allowed)).toBeUndefined();
  });
});

describe("[decorator.unknown-option]: flow decorators", () => {
  it("names the executionLimits of an @Agent that was given maxToolCalls, maxVisits and maxRetries", () => {
    @Agent(
      loose({
        name: "a-one-agent",
        description: "d",
        maxToolCalls: 2,
        maxVisits: 3,
        maxRetries: 1,
      }),
    )
    class One {}

    const found = messagesOf(One);

    expect(found).toHaveLength(3);
    for (const key of ["maxToolCalls", "maxVisits", "maxRetries"]) {
      expect(found.some((m) => m.includes(`${key} is not an option of @Agent`))).toBe(true);
    }
    expect(found.every((m) => m.includes("move it into executionLimits"))).toBe(true);
  });

  it("finds a stray key behind a spread, and suggests the nearest option", () => {
    const shared = { name: "a-two-agent", description: "d", guardrail: [SECRET] };
    @Agent({ ...shared })
    class Two {}

    const [only, ...rest] = messagesOf(Two);

    expect(rest).toEqual([]);
    expect(only).toContain("Two: guardrail is not an option of @Agent — did you mean guardrails?");
  });

  it("checks the nested executionLimits of an @Agent", () => {
    @Agent(
      loose({
        name: "a-three-agent",
        description: "d",
        executionLimits: { maxVisits: 2, maxToolCall: 4 },
      }),
    )
    class Three {}

    expect(messagesOf(Three)).toEqual([
      "Three: maxToolCall is not an option of @Agent (in executionLimits) — did you mean maxToolCalls?",
    ]);
  });

  it("ignores a key whose value is undefined, and keys the type offers", () => {
    @Agent(loose({ name: "a-four-agent", description: "d", maxToolCalls: undefined, rag: [] }))
    class Four {}

    expect(messagesOf(Four)).toEqual([]);
  });

  it("checks @Workflow, its defaults and the nodes @WorkflowStart and @WorkflowFinish", () => {
    @WorkflowStart(
      loose({ name: "u-start-workflow-start", description: "d", input: ItemDto, label: 1 }),
    )
    class Start {}
    @WorkflowFinish(
      loose({ name: "u-finish-workflow-finish", description: "d", output: ItemDto, outputs: 1 }),
    )
    class Finish {}
    @Workflow(
      loose({
        name: "u-flow-workflow",
        version: "1.0.0",
        flow: [onStart(Start).toFinish(Finish)],
        maxStep: 3,
        defaults: { models: { modle: "fast" }, tool: {} },
      }),
    )
    class Flow {}

    const found = messagesOf(Flow, Start, Finish);

    expect(found).toContain("Flow: maxStep is not an option of @Workflow — did you mean maxSteps?");
    expect(found).toContain(
      "Flow: modle is not an option of @Workflow (in defaults.models) — did you mean model?",
    );
    expect(found).toContain(
      "Flow: tool is not an option of @Workflow (in defaults) — did you mean tools?",
    );
    expect(found).toContain("Start: label is not an option of @WorkflowStart");
    expect(found).toContain(
      "Finish: outputs is not an option of @WorkflowFinish — did you mean output?",
    );
  });

  it("checks @Action", () => {
    @Action(loose({ name: "u-act-action", description: "d", timeOut: 1 }))
    class Act {
      execute(): undefined {
        return undefined;
      }
    }

    expect(messagesOf(Act)).toEqual([
      "Act: timeOut is not an option of @Action — did you mean timeout?",
    ]);
  });
});

describe("[decorator.unknown-option]: components", () => {
  it("checks @Tool, @Injectable, @InputGuardrail, @Memory, @ToolInterceptor and @Budget", () => {
    @Tool(loose({ name: "u-tool", description: "d", readonly: true }))
    class OneTool {
      execute(): never {
        throw new Error("not run");
      }
    }
    @Injectable(loose({ dependencies: [] }))
    class Service {}
    @InputGuardrail(loose({ name: "u-guard", treshold: 0.5 }))
    class Guard {}
    @Memory(loose({ name: "u-memory", description: "d", ttl: 1, window: 2 }))
    class Mem {}
    @ToolInterceptor(loose({ name: "u-interceptor", deps: [], order: 1 }))
    class Interceptor {}
    @Budget(loose({ name: "u-budget", scope: "application", period: "day", spend: 1 }))
    class Limit {}

    const found = messagesOf(OneTool, Service, Guard, Mem, Interceptor, Limit);

    expect(found).toEqual([
      "OneTool: readonly is not an option of @Tool — did you mean readOnly?",
      "Service: dependencies is not an option of @Injectable",
      "Guard: treshold is not an option of @InputGuardrail — did you mean threshold?",
      "Mem: window is not an option of @Memory",
      "Interceptor: order is not an option of @ToolInterceptor",
      "Limit: spend is not an option of @Budget",
    ]);
  });

  it("never prints a value", () => {
    @Injectable(loose({ [`note`]: SECRET, deps: [SECRET] }))
    class Leaky {}

    const found = messagesOf(Leaky);

    expect(found).toHaveLength(1);
    expect(found.join("\n")).not.toContain(SECRET);
  });

  it("reaches the classes an application's options list, at any depth", () => {
    @Injectable(loose({ nope: 1 }))
    class Deep {}
    @Memory(loose({ name: "u-mem-two", description: "d", ttl: 1, extra: 1 }))
    class Listed {}
    @Application(
      loose({
        name: "u-listed-application",
        version: "1.0.0",
        environment: EmptyEnvironment,
        workflows: [],
        providers: [Deep, { provide: Symbol("t"), useClass: Listed }],
      }),
    )
    class Root {}

    expect(messagesOf(Root)).toEqual([
      "Deep: nope is not an option of @Injectable",
      "Listed: extra is not an option of @Memory",
    ]);
  });
});

describe("[decorator.unknown-option]: @Application", () => {
  it("names the nested executionLimits and defaults, and the key that moved", () => {
    @Application(
      loose({
        name: "u-app-application",
        version: "1.0.0",
        environment: EmptyEnvironment,
        workflows: [],
        shutdownTimeout: 1,
        executionLimits: { shutdownTimeout: 1, maxSteps: 2 },
        defaults: { workflows: { placment: 1 } },
      }),
    )
    class App {}

    const found = messagesOf(App);

    expect(found).toContain(
      "App: shutdownTimeout is not an option of @Application — move it into executionLimits: { shutdownTimeout: … }",
    );
    expect(found).toContain("App: maxSteps is not an option of @Application (in executionLimits)");
    expect(found).toContain(
      "App: placment is not an option of @Application (in defaults.workflows) — did you mean placement?",
    );
    expect(found).toHaveLength(3);
  });

  it("fails assembly with the code, once per stray key, beside the application's other rules", async () => {
    @WorkflowStart(
      loose({ name: "u-asm-workflow-start", description: "d", input: ItemDto, tag: SECRET }),
    )
    class Start {}
    @WorkflowFinish({ name: "u-asm-workflow-finish", description: "d", output: ItemDto })
    class Finish {}
    @Workflow({
      name: "u-asm-workflow",
      version: "1.0.0",
      flow: [onStart(Start).toFinish(Finish)],
    })
    class Flow {}
    @Application(
      loose({
        name: "u-asm-application",
        version: "1.0.0",
        environment: EmptyEnvironment,
        workflows: [Flow],
        guardrail: [],
      }),
    )
    class App {}

    const failure = await applicationOf(App).then(
      () => undefined,
      (error: unknown) => error,
    );

    if (!(failure instanceof GraphRuleError)) throw failure;
    expect(failure).toBeInstanceOf(GraphRuleError);
    const violations = failure.violations;
    expect(
      violations.map((one) => one.code).filter((code) => code === "decorator.unknown-option"),
    ).toHaveLength(2);
    const text = failure.message;
    expect(text).toContain("guardrail is not an option of @Application — did you mean guardrails?");
    expect(text).toContain("tag is not an option of @WorkflowStart");
    expect(text).not.toContain(SECRET);
    expect(requireApplication(App, "test").options.name).toBe("u-asm-application");
  });
});
