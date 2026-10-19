import type { Mocked } from "vitest";
import type { Class } from "../components/injection.js";
import type { ContainerOptions } from "../components/container/container.js";
import { NodeKind } from "../flow/ast.js";
import type { RuntimeNode } from "../flow/runtime/graph-model.js";
import { actionOutputClassOf } from "./action-output.js";
import { ActionCallRecorder, type ActionScript } from "./action-script.js";
import { TestSetupError } from "./errors.js";
import { nodeNameOf } from "./failure-facts.js";
import { mockInstanceOf } from "./mocks.js";
import type { ScriptBook } from "./script-book.js";
import { ToolScripts, type ToolScript } from "./tool-script.js";

/**
 * What a test replaces or watches in the application's container (#261, #262): `mockOf(Class)`
 * instances, `mockTool(…).thenFail(…)` failures, and every action call for `mockAction(…)`. A mock
 * set after the first app was built would not reach it: a setup error.
 */
export class TestMocks {
  readonly #overrides = new Map<Class, unknown>();
  readonly #tools: ToolScripts;
  /** Every action call of the test (one more observer of each instance). */
  readonly actions: ActionCallRecorder;
  #isStarted = false;

  constructor(
    book: ScriptBook,
    private readonly nodes: readonly RuntimeNode[],
    private readonly used: ReadonlySet<Class>,
  ) {
    this.#tools = new ToolScripts((script) => {
      book.expect(script);
    });
    const labelOf = (name: string): string =>
      nodes.find((node) => node.id === name)?.component.name ?? name;
    this.actions = new ActionCallRecorder(labelOf, actionOutputClassOf(nodes));
  }

  /** The container's options for every app of the test: the mocks, the tool scripts. */
  get container(): ContainerOptions {
    return {
      overrides: this.#overrides,
      onCreate: (instance) => {
        this.#tools.patch(instance);
      },
    };
  }

  /** The first app is being built: from now on mocks cannot be added. */
  started(): void {
    this.#isStarted = true;
  }

  #beforeStart(what: string): void {
    if (this.#isStarted) {
      throw new TestSetupError(
        `${what} after the app started: call it before the first app.execute(…)`,
      );
    }
  }

  mockOf<T>(cls: Class<T>): Mocked<T> {
    const existing = this.#overrides.get(cls);
    // the mock stored for this class was created by mockInstanceOf(cls) below
    if (existing !== undefined) return existing as Mocked<T>;
    if (!this.used.has(cls)) {
      throw new TestSetupError(`mockOf(${cls.name}): not a component of this application`);
    }
    this.#beforeStart(`mockOf(${cls.name})`);
    const mock = mockInstanceOf(cls);
    this.#overrides.set(cls, mock);
    return mock;
  }

  /** The recorded calls of an action of the application (it still runs). */
  mockAction(action: Class): ActionScript {
    const node = this.nodes.find((item) => item.component === action);
    if (node?.kind !== NodeKind.Action) {
      throw new TestSetupError(`mockAction(${action.name}): not an action of this application`);
    }
    return this.actions.callsOf(nodeNameOf(action));
  }

  /** The scripted failures of a tool of the application. */
  mockTool(tool: Class): ToolScript {
    if (!this.used.has(tool)) {
      throw new TestSetupError(`mockTool(${tool.name}): not a tool of this application`);
    }
    this.#beforeStart(`mockTool(${tool.name})`);
    return this.#tools.scriptOf(tool);
  }
}
