import type { Class } from "../components/injection.js";
import type { ModelScript } from "./script-book.js";
import { testModule, type TestModule, type TestModuleOptions } from "./test-module.js";

/**
 * `testAgent(Agent, { workflow })` (#1328): one `@Agent` on its own — its real loop (tools,
 * interceptors, guardrails, PII policies, judges) over scripted models — as `testModule` builds it.
 * An agent is part of a workflow's graph in 0.1.1 (its prompt, model and tools come from the config
 * that workflow assembles), so the workflow it is in is named.
 */

/** What `testAgent` takes: the workflow of the agent, and the module's own options. */
export interface TestAgentOptions extends Omit<TestModuleOptions, "components"> {
  /** The `@Workflow` the agent is a node of. */
  readonly workflow: Class;
  /** Services and infrastructure the agent's tools use, besides what its workflow lists. */
  readonly components?: readonly Class[];
}

/**
 * The agent as a function of its input message: `await agent("Where is order 9?")` is its reply —
 * its text, or its answer's JSON. `run` is the same call by name; the mocks and the clock are the
 * module's.
 */
export interface AgentRunner extends Pick<
  TestModule,
  "mockTool" | "mockService" | "mockMcp" | "mockRag" | "mockA2A" | "clock" | "close" | "get"
> {
  (input: string): Promise<string>;
  run(input: string): Promise<string>;
  /** The script of the agent's own model, or of another component's (a `@Judge`, a router). */
  mockModel(component?: Class): ModelScript;
}

/** One agent of a workflow, its module assembled (every assembly error fails here). */
export async function testAgent(agent: Class, options: TestAgentOptions): Promise<AgentRunner> {
  const { workflow, components = [], ...rest } = options;
  const module = await testModule({ ...rest, components: [workflow, ...components] });
  const run = (input: string): Promise<string> => module.runAgent(agent, input);
  return Object.assign(run, {
    run,
    mockModel: (component: Class = agent): ModelScript => module.mockModel(component),
    mockTool: module.mockTool.bind(module),
    mockService: module.mockService.bind(module),
    mockMcp: module.mockMcp.bind(module),
    mockRag: module.mockRag.bind(module),
    mockA2A: module.mockA2A.bind(module),
    clock: module.clock,
    get: module.get.bind(module),
    close: () => module.close(),
  });
}
