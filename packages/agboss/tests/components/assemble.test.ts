import { file } from "../../src/components/file.js";

import { describe, expect, it } from "vitest";
import {
  Agent,
  Workflow,
  Injectable,
  ROUTER_FACTORY,
  provide,
  ComponentError,
  Tool,
} from "../../src/index.js";
import { workflowOf, toolOf } from "../../src/testing/index.js";
import { createContainer } from "../../src/components/container/container.js";
import { checkGraph } from "../../src/components/container/graph-check.js";
import { recordComponent } from "../../src/components/metadata.js";
import type { WorkflowServices } from "../../src/workflow.js";
import type { ToolInvocationContext } from "../../src/tools/index.js";
import type { ToolHandlerClass } from "../../src/components/decorators.js";
import type { Class } from "../../src/components/injection.js";
import { testConfig, testDefaults } from "../helpers.js";
import {
  FilesServer,
  Greeter,
  GreeterAgent,
  Greetings,
  GreetTool,
  GREETING,
} from "./fixture/components.js";
import { starOf } from "../fixtures/test-flow/star.js";

const services: WorkflowServices = {
  router: (name) => ({ name, route: () => Promise.reject(new Error("unused")) }),
};
const ctx: ToolInvocationContext = {
  signal: new AbortController().signal,
  reportCost: () => undefined,
};

const baseBundle = {
  version: "1.0.0",
  defaults: testDefaults,
};

describe("components — assembly", () => {
  it("AC1: a tool is one annotated class referenced by an agent; the container injects its dependencies", async () => {
    const bundle = await workflowOf(Greetings);
    const tools = typeof bundle.tools === "function" ? bundle.tools(services) : bundle.tools;
    const greet = tools.find((tool) => tool.name === "greet-tool");

    expect(bundle.config.agents["greeter-agent"]?.tools).toEqual(["greet-tool", "read-file-tool"]);
    expect(await greet?.invoke({ name: "Pavel" }, ctx)).toEqual({
      kind: "ok",
      value: { text: "Shalom, Pavel" },
    });
  });

  it("AC1: a tool is testable with plain `new` and fakes — no container", async () => {
    const tool = toolOf(new GreetTool(new Greeter("Hi", services.router)));

    expect(await tool.invoke({ name: "you" })).toEqual({
      kind: "ok",
      value: { text: "Hi, you" },
    });
    expect((await tool.invoke({ nope: 1 })).kind).toBe("error");
  });

  it("AC2: agents (settings, prompt file with variables) and MCP servers come from their classes", async () => {
    const bundle = await workflowOf(Greetings);

    expect(bundle.config).toMatchObject({
      name: "greetings-workflow",
      version: "1.0.0",
      mcpServers: { files: { transport: "stdio", command: "files-server" } },
    });
    expect(bundle.config.agents["greeter-agent"]).toMatchObject({
      model: "test/alpha",
      thinking: Reasoning.on({ effort: ReasoningEffort.Low }),
      description: "Greets people",
    });
    const text = bundle.prompts["greeter-agent"];
    expect(text?.trim()).toBe("You greet people in Hebrew.");
    expect(bundle.mcpServers.map((server) => server.name)).toEqual(["files"]);
  });
});

import { Reasoning, ReasoningEffort } from "../../src/models/index.js";

describe("components — errors at assembly", () => {
  it("AC3: unknown prompt variables fail at assembly", async () => {
    @Agent({
      name: "tester-agent",
      description: "d",
      model: "test/alpha",
      price: testConfig.agents.alpha.price,
      tools: [],
      prompt: "Hello {{unknown_var}}",
      promptVariables: {},
    })
    class Tester {}

    @Workflow({
      ...baseBundle,
      name: "tester-workflow",
      flow: starOf(Tester),
    })
    class TesterFlow {}

    await expect(workflowOf(TesterFlow)).rejects.toThrow(
      '[prompt.unknown-variable] @Agent "tester-agent" prompt:1 {{unknown_var}} — known: (none)',
    );
  });

  it("AC3: an unregistered provider names the component", async () => {
    @Workflow({
      ...baseBundle,
      name: "no-providers-workflow",
      flow: starOf(GreeterAgent),
      mcp: [FilesServer],
    })
    class NoProviders {}

    await expect(workflowOf(NoProviders)).rejects.toThrow(
      'GreetTool: "Greeter" is not registered in @Workflow({ providers })',
    );
  });

  it("AC3: a dependency cycle names the chain", () => {
    const deps: { a?: unknown; b?: unknown } = {};
    @Injectable({ deps: [] })
    class A {}
    @Injectable({ deps: [] })
    class B {}
    recordComponent(A, { kind: "injectable", meta: { deps: [B] } });
    recordComponent(B, { kind: "injectable", meta: { deps: [A] } });

    expect(() => {
      checkGraph([A], [{ owner: "x-workflow", providers: [A, B] }], []);
    }).toThrow("Dependency cycle: A → B → A");
    expect(deps).toEqual({});
  });

  it("AC3: a non-component in tools fails", async () => {
    /** Shaped like a tool (the compiler accepts it), but not decorated: the assembly rejects it. */
    class Plain {
      run(): Promise<object> {
        return Promise.resolve({});
      }
    }

    const agent = (prompt: any, tools: ToolHandlerClass[] = []) => {
      @Agent({
        name: "a-agent",
        description: "d",
        model: "test/alpha",
        price: testConfig.agents.alpha.price,
        tools,

        prompt: prompt,
      })
      class A {}
      return A;
    };
    const bundleWith = (agentClass: Class) => {
      @Workflow({ ...baseBundle, name: "x-workflow", flow: starOf(agentClass) })
      class B {}
      return B;
    };
    const prompt = file("./fixture/greeter.prompt.md");

    await expect(workflowOf(bundleWith(agent(prompt, [Plain])))).rejects.toThrow(
      /Plain in an agent's tools is not a @Tool/,
    );
  });

  it("AC3: instances are created once, dependencies before dependants", () => {
    const container = createContainer({
      modules: [{ owner: "x-workflow", providers: [Greeter, provide(GREETING, "Hey")] }],
      core: new Map([[ROUTER_FACTORY, services.router]]),
    });
    const first = container.get(GreetTool);

    expect(container.get(GreetTool)).toBe(first);
    expect(container.created).toEqual(["Greeter", "GreetTool"]);
  });
});
